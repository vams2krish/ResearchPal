"""Anatomy-driven paper pipeline: raw PDF text -> the paper organized into
its canonical structure (core.anatomy.SECTIONS), with each section carrying
a plain-language explanation, any formulas/tables/code/figures it contains,
plus paper-wide claim cards, flashcards, and an architecture/pathway diagram.

Kept as plain prompt -> JSON calls (no agent framework): a small, fixed
number of LLM calls per paper regardless of section count, so processing
time stays predictable on a local model.
"""

import re
from pathlib import Path

from core import anatomy, config, db, llm, vectorstore

# Local models (esp. smaller Ollama ones) have limited context windows.
# Truncating keeps the pipeline reliable across both backends.
MAX_CHARS = 24000
MAX_CHARS_PER_SECTION = 2800

HEADING_RE = re.compile(r"^(#{1,4})\s+(.*)$", re.MULTILINE)
TABLE_ROW_RE = re.compile(r"^\|.*\|[ \t]*$", re.MULTILINE)
CODE_BLOCK_RE = re.compile(r"```.*?```", re.DOTALL)
IMAGE_RE = re.compile(r"!\[[^\]]*\]\(([^)]+)\)")
CAPTION_RE = re.compile(r"^(Figure|Fig\.|Table)\s+\d+[:.)]?\s*.{0,200}", re.IGNORECASE)


def _clip(text: str, limit: int = MAX_CHARS) -> str:
    return text[:limit]


def _clean_heading(raw: str) -> str:
    return raw.strip().strip("*").strip()


def _generate_dict(prompt: str, retries: int = 1) -> dict:
    result = {}
    for _ in range(retries + 1):
        try:
            result = llm.generate_json(prompt)
        except llm.LLMError:
            result = {}
            continue
        if isinstance(result, dict) and result:
            break
    return result if isinstance(result, dict) else {}


def _generate_list(prompt: str, key: str, retries: int = 1) -> list:
    """Small local models occasionally return an empty/malformed structured
    response -- and even hosted ones can return truncated JSON that fails to
    parse outright. One silent retry is cheap insurance against a paper
    ending up with no claims/flashcards for no visible reason."""
    items = []
    for _ in range(retries + 1):
        try:
            result = llm.generate_json(prompt)
        except llm.LLMError:
            items = []
            continue
        items = result if isinstance(result, list) else result.get(key, [])
        if items:
            break
    return items


# ---------------------------------------------------------- Structural pass
def split_into_blocks(full_text: str) -> list[dict]:
    """Programmatic (no LLM) split on markdown headings. Text before the
    first heading becomes a synthetic "Front Matter" block -- usually the
    title/author/abstract preamble."""
    matches = list(HEADING_RE.finditer(full_text))
    blocks = []
    if matches and matches[0].start() > 0:
        blocks.append({"title": "Front Matter", "start": 0, "end": matches[0].start()})
    for i, m in enumerate(matches):
        end = matches[i + 1].start() if i + 1 < len(matches) else len(full_text)
        blocks.append({"title": _clean_heading(m.group(2)), "start": m.end(), "end": end})
    for b in blocks:
        b["body"] = full_text[b["start"]:b["end"]].strip()
    return [b for b in blocks if b["body"]]


def classify_blocks(blocks: list[dict]) -> list[str]:
    """One LLM call: map each raw heading to a canonical anatomy section."""
    if not blocks:
        return []
    numbered = "\n".join(f"{i}: {b['title']}" for i, b in enumerate(blocks))
    categories = ", ".join(f'"{s}"' for s in anatomy.SECTIONS)
    prompt = f"""Classify each research-paper section heading below into exactly
one of these canonical categories: {categories}, or "Other" if it truly fits
none of them (e.g. Acknowledgments, Author Contributions, Funding).

IMPORTANT: "Title and Abstract" should almost always be only ONE heading (the
"Front Matter" preamble and/or a heading literally titled "Abstract") -- if
you are about to assign it to more than two headings, you are almost
certainly wrong. Many papers (especially biology/medicine, Nature-style)
present their Results as a series of narrative headings that state a finding
directly, e.g. "Compound X inhibits Y", "Discovery of Z", "Structural
analysis revealed...", "A binds B and blocks C". These are ALWAYS "Results",
never "Title and Abstract" or "Introduction", no matter how early they appear
or how much they resemble a sentence rather than a topic label.

Other guidelines:
- "Background", "Preliminaries" -> usually "Related Work" (unless it's really
  establishing the problem, then "Introduction").
- Headings about datasets, baselines, hyperparameters, evaluation protocol,
  implementation details, screening/assay protocols -> "Experimental Setup".
- A numbered or narrative subsection belongs to the same category as the
  section it's part of -- judge by what kind of content it is, not just
  its position in the list.
- Visualizations, proofs, extra derivations, supplementary material,
  ethics statements, data/code availability -> "Appendix".
- "References" / "Bibliography" -> "References".

Headings (index: text):
{numbered}

Return ONLY a JSON object mapping each index (as a string) to its category.
Every index from 0 to {len(blocks) - 1} must appear exactly once.
"""
    mapping = _generate_dict(prompt)
    return [mapping.get(str(i), "Other") for i in range(len(blocks))]


def extract_tables(text: str) -> list[dict]:
    lines = text.split("\n")
    tables, current, start_idx = [], [], None
    for i, line in enumerate(lines):
        if TABLE_ROW_RE.match(line):
            if not current:
                start_idx = i
            current.append(line)
        else:
            if current:
                tables.append((start_idx, "\n".join(current)))
            current = []
    if current:
        tables.append((start_idx, "\n".join(current)))

    results = []
    for start_idx, md in tables:
        if md.count("\n") < 1:
            continue  # a lone pipe-containing line isn't a real table
        if re.search(r"received:|accepted:|check for updates", md, re.IGNORECASE):
            continue  # journal author/DOI banner, not real data -- not tied to one block
        caption = ""
        for back in range(max(0, start_idx - 3), start_idx):
            m = CAPTION_RE.match(lines[back].strip())
            if m:
                caption = m.group(0).strip()
        results.append({"markdown": md, "caption": caption})
    return results


def extract_code_blocks(text: str) -> list[str]:
    return [m.strip("`\n ") for m in CODE_BLOCK_RE.findall(text)]


def _looks_like_real_figure(file_path: str) -> bool:
    """pymupdf4llm rasterizes anything it can't extract as text, including
    single-line equations it failed to parse -- those come out as extreme
    wide-short slivers (aspect ratio > 4), unlike genuine figures/diagrams."""
    try:
        from PIL import Image

        with Image.open(file_path) as im:
            w, h = im.size
        return h > 0 and max(w, h) / min(w, h) <= 4
    except Exception:
        return True  # can't tell -- don't silently drop it


def extract_images(text: str) -> list[dict]:
    results = []
    for m in IMAGE_RE.finditer(text):
        # pymupdf4llm's markdown image reference comes back relative to the
        # project root (where write_images actually saved the file), not
        # necessarily whatever CWD the *reading* process has -- resolve
        # explicitly against ROOT_DIR so it loads correctly regardless of
        # which process (Streamlit app, a script run from elsewhere) reads it.
        raw_path = Path(m.group(1))
        file_path = str(raw_path if raw_path.is_absolute() else (config.ROOT_DIR / raw_path).resolve())
        if not Path(file_path).exists() or not _looks_like_real_figure(file_path):
            continue
        # Only trust a caption on the next non-empty line right after the
        # image -- searching a wider window picks up unrelated mid-sentence
        # citations like "...as shown in Fig. 4B)." from elsewhere nearby.
        caption = ""
        for line in text[m.end():m.end() + 300].split("\n"):
            line = line.strip()
            if not line:
                continue
            cm = CAPTION_RE.match(line)
            caption = cm.group(0).strip() if cm else ""
            break
        results.append({"file_path": file_path, "caption": caption})
    return results


def group_by_section(blocks: list[dict], categories: list[str]) -> dict[str, dict]:
    """Merge raw blocks into canonical sections, collecting each section's
    text plus the tables/code/images physically inside it."""
    grouped: dict[str, dict] = {}
    for block, cat in zip(blocks, categories):
        if cat == "Other":
            cat = "Appendix"  # keep the content visible rather than dropping it
        if cat not in anatomy.SECTIONS:
            continue
        g = grouped.setdefault(cat, {"raw_text": "", "tables": [], "code_blocks": [], "images": []})
        g["raw_text"] += ("\n\n" if g["raw_text"] else "") + block["body"]
        # The synthetic "Front Matter" preamble (title/authors/DOI banner) is
        # never a real data table -- it's just PDF layout coincidentally
        # falling into pipe-table syntax.
        if block["title"] != "Front Matter":
            g["tables"].extend(extract_tables(block["body"]))
        g["code_blocks"].extend(extract_code_blocks(block["body"]))
        g["images"].extend(extract_images(block["body"]))
    return grouped


# ------------------------------------------------------------- LLM analysis
def analyze_sections(grouped: dict[str, dict]) -> dict[str, dict]:
    """One batched LLM call: plain-language explanation + formula extraction
    for every non-empty, analyzable section."""
    names = [n for n in anatomy.ANALYZABLE_SECTIONS if n in grouped and grouped[n]["raw_text"].strip()]
    if not names:
        return {}

    material = "\n\n".join(
        f"=== SECTION: {name} ===\n{_clip(grouped[name]['raw_text'], MAX_CHARS_PER_SECTION)}"
        for name in names
    )
    prompt = f"""You are helping a researcher who finds dense academic writing and
heavy math notation hard to parse. Below are excerpts from different sections
of one paper. For EACH section listed, produce a plain-language explanation
and extract any non-trivial equations/formulas it contains.

Rules for "equation_raw" in formulas (critical):
- A SINGLE valid LaTeX expression that renders correctly on its own with
  KaTeX -- nothing else will be shown but this string rendered as math.
- No prose, no "and", no multiple equations joined together -- split them.
- Use \\text{{...}} only for short embedded words, never full sentences.
- For chemistry, use standard LaTeX subscripts and \\rightarrow, not \\ce{{}}.
- Do not wrap in $ or $$ delimiters.

Return ONLY a JSON object keyed EXACTLY by these section names: {names}
Each value must have this exact shape:
{{
  "explanation": "4-6 sentence plain-language explanation of what this section says",
  "formulas": [
    {{
      "domain": "Math" | "Physics" | "Chemistry" | "Biology" | "Computer Science" | "Other",
      "equation_raw": "a single clean LaTeX expression",
      "plain_explanation": "what each symbol/term means and what it computes, in plain words",
      "practical_meaning": "why this equation matters here, in one or two sentences"
    }}
  ]
}}
Use an empty array for "formulas" if a section has none.

SECTIONS:
{material}
"""
    result = _generate_dict(prompt)
    for name, payload in result.items():
        for eq in payload.get("formulas", []):
            eq["equation_raw"] = eq.get("equation_raw", "").strip().strip("$").strip()
    return result


def extract_metadata(full_text: str) -> dict:
    """Title/authors/year/venue from the paper's own front matter -- the
    title in particular replaces the upload-filename placeholder everywhere
    it's shown (library cards, paper header, exports) and drives renaming
    the stored file to something a reader can actually recognize."""
    prompt = f"""Extract publication metadata from the front matter of this
paper (title page, header/footer, DOI banner).

Return ONLY a JSON object with these exact keys (use "" if genuinely not
findable, don't guess):
{{
  "title": "the paper's actual title, exactly as printed -- not a filename or arXiv id",
  "authors": "comma-separated author names as they appear, e.g. 'J. Smith, A. Lee'",
  "year": "4-digit publication year",
  "venue": "journal/conference name if stated, else \"\""
}}

TEXT:
{_clip(full_text, 3000)}
"""
    result = _generate_dict(prompt)
    return {
        "title": result.get("title", "") or "",
        "authors": result.get("authors", "") or "",
        "year": result.get("year", "") or "",
        "venue": result.get("venue", "") or "",
    }


def _sanitize_filename(name: str, max_len: int = 150) -> str:
    """A paper title turned into a safe file name -- strips characters
    illegal on Windows (the primary target platform here), collapses
    whitespace, and caps length so an unusually long title doesn't hit
    filesystem path limits."""
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "", name).strip()
    cleaned = re.sub(r"\s+", " ", cleaned)
    cleaned = cleaned.strip(" .")  # Windows also disallows trailing dots/spaces
    return cleaned[:max_len].strip() or "paper"


def generate_glossary(full_text: str) -> list[dict]:
    """5-10 key technical terms with plain-language definitions -- becomes
    part of a searchable personal glossary across the whole library."""
    prompt = f"""Identify 5-10 key technical terms, acronyms, or jargon in this
paper that a newcomer to the field would need explained. Skip generic words.

Return ONLY a JSON array, each element with these exact keys:
{{
  "term": "the term or acronym as used in the paper",
  "definition": "a one to two sentence plain-language definition, specific to how this paper uses it"
}}

PAPER TEXT:
{_clip(full_text)}
"""
    return _generate_list(prompt, "glossary")


def generate_claims(full_text: str) -> list[dict]:
    prompt = f"""Extract the paper's main claims as structured claim cards, so a
reader can evaluate them critically instead of just accepting them.

Return ONLY a JSON array (3-8 items), each element with these exact keys:
{{
  "claim": "the specific claim being made",
  "evidence": "what evidence/data/experiment supports it",
  "assumptions": "what has to be true for this claim to hold, that isn't proven here",
  "limitations": "scope conditions, caveats, or reasons to doubt generalizability"
}}

PAPER TEXT:
{_clip(full_text)}
"""
    return _generate_list(prompt, "claims")


def generate_first_principles(full_text: str) -> list[str]:
    """Decompose the paper's core problem and contribution into a chain of
    foundational, self-evident statements -- reasoning built up from bedrock
    facts, not reasoning by analogy to other known systems/methods (which is
    what the paper's own explanation and this app's other summaries already
    do). Each statement should stand on its own as something the reader can
    verify is true independent of trusting the paper's framing."""
    prompt = f"""Break this paper's core problem and contribution down using
FIRST-PRINCIPLES THINKING: a chain of foundational, self-evident statements
that build on each other, arriving at the paper's key insight through
undeniable truths rather than comparison or analogy.

Rules:
- Do NOT explain anything by saying it's "like" or "similar to" something
  else -- no analogies, no comparisons to other named methods/systems.
- Each statement must be something true on its own terms (a definition, a
  logical necessity, a directly stated fact/measurement), not an opinion or
  a restatement of the paper's marketing.
- Order matters: statement 1 is the most basic, undeniable starting fact;
  each later statement should build on the ones before it; the final
  statement should arrive at the paper's actual core contribution as the
  logical consequence of everything before it.

Return ONLY a JSON array of 5-8 strings, one statement per element, in order.

PAPER TEXT:
{_clip(full_text)}
"""
    return [s for s in _generate_list(prompt, "statements") if isinstance(s, str) and s.strip()]


def generate_flashcards(title: str, sections: dict[str, dict]) -> list[dict]:
    material_parts = [f"Paper: {title}"]
    for name, payload in sections.items():
        formulas = [(f.get("equation_raw"), f.get("plain_explanation")) for f in payload.get("formulas", [])]
        material_parts.append(f"[{name}] {payload.get('explanation', '')}" + (f" Formulas: {formulas}" if formulas else ""))
    material = "\n\n".join(material_parts)

    prompt = f"""Turn the material below into spaced-repetition flashcards.
Favor questions that require recall + a small amount of reasoning over pure
fact lookup (e.g. "why does X follow from Y" rather than only "what is X").
Include at least one comparison/synthesis-style card if the material supports it.

Return ONLY a JSON array (6-12 items), each element with these exact keys:
{{
  "card_type": "definition" | "equation" | "claim" | "comparison",
  "front": "the question/prompt shown first",
  "back": "the answer, kept concise"
}}

MATERIAL:
{material}
"""
    return _generate_list(prompt, "flashcards")


def generate_diagram(full_text: str) -> str | None:
    """Ask the model for one Mermaid diagram capturing the paper's core
    process/architecture/pathway, if one is describable. Works across domains:
    an algorithm pipeline, a biological pathway, a chemical reaction sequence,
    a physical system -- whatever structure the paper actually has."""
    prompt = f"""Read the paper text below. If it describes a process, pipeline,
architecture, workflow, causal chain, or pathway (biological, chemical,
computational, or physical) that could be drawn as a diagram, produce ONE
Mermaid diagram capturing its key stages/components and how they connect.

Use "flowchart TD" syntax. Keep node labels short (a few words). Prefer
correctness and simplicity over completeness -- 4 to 10 nodes is plenty.

Formatting rules (critical -- broken syntax means nothing renders at all):
- ALWAYS wrap every node label in double quotes, regardless of shape, e.g.
  A["Input tokens"], B("Embeddings + positional encoding"), C{{"Encoder stack"}}.
  Quoting lets labels safely contain punctuation like parentheses or commas.
- Do not put semicolons after statements.
- Use only plain ASCII characters in labels (no special symbols, no LaTeX).
- One edge per line, e.g. A --> B

Return ONLY the raw Mermaid code, nothing else -- no markdown fences, no
explanation. If nothing in this paper is meaningfully diagrammable, return
exactly: NONE

PAPER TEXT:
{_clip(full_text)}
"""
    raw = llm.generate(prompt).strip()
    if raw.startswith("```"):
        raw = raw.strip("`")
        if raw.lower().startswith("mermaid"):
            raw = raw[len("mermaid"):]
    raw = raw.strip()
    if not raw or raw.upper() == "NONE":
        return None
    return raw


def _mm_node(content: str, children: list[dict] | None = None) -> dict:
    return {"content": content, "children": children or []}


def generate_mindmap_tree(paper_title: str, sections: list[dict], equations: list[dict],
                           images: list[dict], tables: list[dict]) -> dict:
    """Built entirely from data already extracted -- no LLM call, so it's
    instant and free, and available even for papers processed before this
    feature existed (just re-derived from their stored sections/equations).
    Returns a {content, children} tree for markmap-view, which renders it as
    a real interactive mind map: click any node to expand/collapse it."""
    def count_by_section(rows):
        counts: dict[str, int] = {}
        for r in rows:
            counts[r["section_name"]] = counts.get(r["section_name"], 0) + 1
        return counts

    eq_counts = count_by_section(equations)
    img_counts = count_by_section(images)
    tbl_counts = count_by_section(tables)

    branches = []
    for s in sections:
        if s["name"] == "References":
            continue
        children = []
        first_sentence = (s["explanation"] or "").split(". ")[0].strip()
        if first_sentence:
            children.append(_mm_node(first_sentence))
        for count, noun in ((eq_counts.get(s["name"]), "formula"), (img_counts.get(s["name"]), "figure"), (tbl_counts.get(s["name"]), "table")):
            if count:
                children.append(_mm_node(f"{count} {noun}{'s' if count != 1 else ''}"))
        branches.append(_mm_node(f"{anatomy.SECTION_ICONS.get(s['name'], '')} {s['name']}", children))

    return _mm_node(paper_title, branches)


def build_full_audio_script(paper_id: str) -> tuple[str, list[dict]]:
    """Build one read-aloud script for the whole paper, in canonical anatomy
    order, out of content that's already plain-language (section explanations,
    equations' plain_explanation) -- tables/figures/code aren't speakable, so
    they get a short spoken placeholder instead of being read literally.
    Returns (script_text, section_markers) where section_markers is
    [{"section_name", "char_offset"}], the character offset in script_text
    where each section's narration begins (fed to audio.synthesize_full_script
    to resolve real audio-time jump points)."""
    paper = db.get_paper(paper_id)
    sections = db.get_sections(paper_id)
    equations = db.get_equations(paper_id)
    images = db.get_images(paper_id)
    tables = db.get_tables(paper_id)

    def group(rows):
        out: dict[str, list] = {}
        for r in rows:
            out.setdefault(r["section_name"], []).append(r)
        return out

    eq_by_section = group(equations)
    img_by_section = group(images)
    tbl_by_section = group(tables)

    parts = [f"{paper['title']}."]
    markers = []
    char_offset = len("".join(parts))

    for s in sections:
        if s["name"] == "References":
            continue
        markers.append({"section_name": s["name"], "char_offset": char_offset})

        chunk = [f"Section: {s['name']}.", s["explanation"] or ""]
        for eq in eq_by_section.get(s["name"], []):
            if eq["plain_explanation"]:
                chunk.append(f"There is a formula here: {eq['plain_explanation']}")
        n_tables = len(tbl_by_section.get(s["name"], []))
        if n_tables:
            noun = "table" if n_tables == 1 else f"{n_tables} tables"
            chunk.append(f"The data is presented in a {noun} here, which you can look at below.")
        n_images = len(img_by_section.get(s["name"], []))
        if n_images:
            noun = "figure" if n_images == 1 else f"{n_images} figures"
            chunk.append(f"There is a {noun} here, which you can look at below.")

        section_text = " ".join(p.strip() for p in chunk if p and p.strip()) + " "
        parts.append(section_text)
        char_offset += len(section_text)

    return "".join(parts), markers


def _one_liner_from(explanation: str) -> str:
    m = re.search(r"(.+?[.!?])(\s|$)", explanation.strip())
    return (m.group(1) if m else explanation).strip()


def _rename_stored_file_to_title(paper_id: str, real_title: str):
    """Once the paper's real title is known, rename the stored PDF from the
    upload filename (often an arXiv id or a downloaded-file slug) to
    something a reader can actually recognize in a file browser or export.
    Best-effort: any failure here (permissions, an already-open file handle)
    just leaves the original filename in place rather than breaking the
    rest of processing."""
    paper = db.get_paper(paper_id)
    if not paper:
        return
    old_path = config.PAPERS_DIR / paper_id / paper["filename"]
    if not old_path.exists():
        return
    new_name = f"{_sanitize_filename(real_title)}{old_path.suffix}"
    if new_name == paper["filename"]:
        return
    new_path = old_path.parent / new_name
    try:
        old_path.rename(new_path)
        db.set_paper_filename(paper_id, new_name)
    except OSError:
        pass  # keep the original filename rather than fail the whole pipeline


def process_paper(paper_id: str, title: str, full_text: str, progress_cb=None):
    """Run the full anatomy-driven pipeline for one paper and persist everything."""

    def step(msg):
        if progress_cb:
            progress_cb(msg)

    step("Extracting title/authors/year/venue...")
    meta = extract_metadata(full_text)
    real_title = meta.pop("title", "")
    db.set_paper_metadata(paper_id, title=real_title or None, **meta)
    if real_title:
        title = real_title  # used below for flashcard generation context
        _rename_stored_file_to_title(paper_id, real_title)

    step("Detecting paper structure (headings)...")
    blocks = split_into_blocks(full_text)

    step("Classifying sections (Introduction, Methods, Results, ...)...")
    categories = classify_blocks(blocks)
    grouped = group_by_section(blocks, categories)

    step("Writing plain-language explanations + finding formulas...")
    analysis = analyze_sections(grouped)

    sections_to_save = []
    all_equations = []
    images_to_save = []
    tables_to_save = []
    for name in anatomy.SECTIONS:
        g = grouped.get(name)
        if not g or not g["raw_text"].strip():
            continue
        payload = analysis.get(name, {})
        sections_to_save.append({
            "name": name,
            "raw_text": g["raw_text"],
            "explanation": payload.get("explanation", ""),
            "code_snippet": "\n\n---\n\n".join(g["code_blocks"]) if g["code_blocks"] else None,
        })
        for eq in payload.get("formulas", []):
            eq["section_name"] = name
            all_equations.append(eq)
        for img in g["images"]:
            img["section_name"] = name
            images_to_save.append(img)
        for tbl in g["tables"]:
            tbl["section_name"] = name
            tables_to_save.append(tbl)

    db.save_sections(paper_id, sections_to_save)
    db.save_equations(paper_id, all_equations)
    db.save_paper_images(paper_id, images_to_save)
    db.save_paper_tables(paper_id, tables_to_save)

    abstract = next((s for s in sections_to_save if s["name"] == "Title and Abstract"), None)
    if abstract and abstract["explanation"]:
        db.set_paper_one_liner(paper_id, _one_liner_from(abstract["explanation"]))

    step("Extracting claim cards...")
    claims = generate_claims(full_text)
    db.save_claims(paper_id, claims)

    step("Breaking the problem down to first principles...")
    first_principles = generate_first_principles(full_text)
    db.save_first_principles(paper_id, first_principles)

    step("Generating flashcards...")
    section_payloads = {s["name"]: analysis.get(s["name"], {}) for s in sections_to_save}
    cards = generate_flashcards(title, section_payloads)
    db.save_flashcards(paper_id, cards)

    step("Drawing a process diagram (if applicable)...")
    diagram = generate_diagram(full_text)
    db.save_diagram(paper_id, diagram)

    step("Building glossary of key terms...")
    glossary = generate_glossary(full_text)
    db.save_glossary(paper_id, glossary)

    step("Indexing for search (local embeddings)...")
    vectorstore.index_paper(paper_id, full_text)

    db.set_paper_status(paper_id, "processed")
    step("Done.")


COMPARE_ASPECTS = [
    "Problem addressed", "Method / approach", "Dataset(s) or subject",
    "Key metric(s)", "Headline result", "Claimed novelty", "Key limitation",
]
COMPARE_PER_PAPER_CLIP = 6000


def compare_papers(paper_ids: list[str]) -> dict:
    """Structured side-by-side comparison across 2-4 papers: one LLM call
    returning the same fixed set of aspects for every paper, so the result
    renders as a table instead of prose the reader has to align themselves."""
    papers = [p for p in (db.get_paper(pid) for pid in paper_ids) if p]
    if len(papers) < 2:
        return {"papers": [], "rows": []}

    material = "\n\n".join(
        f"=== PAPER {i} ({p['title']}) ===\n{_clip(p['full_text'], COMPARE_PER_PAPER_CLIP)}"
        for i, p in enumerate(papers)
    )
    aspects = ", ".join(f'"{a}"' for a in COMPARE_ASPECTS)
    prompt = f"""Compare these {len(papers)} research papers side by side, strictly
for these aspects: {aspects}.

Return ONLY a JSON object keyed EXACTLY by paper index as a string ("0", "1", ...),
each value an object keyed EXACTLY by the aspect names above, with a short
(1-2 sentence) value specific to that paper. Be concrete -- name actual
numbers, dataset names, or method names when the text supports it, instead of
vague hedging. If the text genuinely doesn't cover an aspect for a paper, use
"Not stated".

PAPERS:
{material}
"""
    result = _generate_dict(prompt)
    rows = [
        {
            "aspect": aspect,
            "values": {p["id"]: result.get(str(i), {}).get(aspect, "") for i, p in enumerate(papers)},
        }
        for aspect in COMPARE_ASPECTS
    ]
    return {"papers": [{"id": p["id"], "title": p["title"]} for p in papers], "rows": rows}


def suggest_mental_models(full_text: str, canonical_names: list[str]) -> list[dict]:
    """LLM-assisted tagging: pick which mental models/frameworks of thinking
    this paper exemplifies or challenges, grounded in a canonical vocabulary
    but free to propose a new one when nothing fits. Returns suggestions only
    -- the caller decides which to actually save."""
    names = ", ".join(f'"{n}"' for n in canonical_names)
    prompt = f"""You are helping a researcher build a personal index of mental
models and frameworks of thinking that different papers exemplify, rely on,
or challenge -- for systems thinking and cross-domain pattern recognition,
not just summarizing the paper's topic.

Given the paper text below, pick 2-5 mental models from this canonical list
that this paper most clearly exemplifies, relies on, or challenges:
{names}.
Only propose a new mental model not in the list if none of them genuinely
fit -- prefer the canonical list when a reasonable match exists.

Return ONLY a JSON array, each element with these exact keys:
{{
  "name": "the mental model name (from the list, or your new one)",
  "note": "one sentence on specifically how/where this paper exemplifies, relies on, or challenges it"
}}

PAPER TEXT:
{_clip(full_text)}
"""
    return _generate_list(prompt, "models")


def synthesize(question: str, paper_ids: list[str] | None, mode: str = "answer") -> str:
    hits = vectorstore.search(question, paper_ids=paper_ids, top_k=10)
    if not hits:
        return "No indexed papers to search yet. Process at least one paper first."

    context = "\n\n---\n\n".join(
        f"[{row['paper_title']}]\n{row['chunk_text']}" for _score, row in hits
    )

    if mode == "critique":
        instructions = """Do not just answer directly. Instead, act as a critical
research mentor: pose 3-5 probing questions that force the reader to evaluate,
compare, and synthesize the retrieved excerpts themselves (e.g. unstated
assumptions, contradictions between papers, what evidence would change the
conclusion, how methods generalize). End with one sentence naming the single
most important tension across these excerpts, without resolving it for them."""
    elif mode == "systems":
        instructions = """Analyze these excerpts as a systems thinker, not a
summarizer. Structure your answer under exactly these four headings, grounded
concretely in the excerpts (don't philosophize in the abstract):
1. Feedback loops -- reinforcing or balancing loops implied by the mechanisms described.
2. Leverage points -- where a small change would have an outsized effect.
3. Second-order effects -- consequences of the consequences, which the excerpts don't explicitly discuss.
4. Stocks, flows, and thresholds -- accumulating quantities, their rates of change, and any tipping points at play."""
    else:
        instructions = """Answer using only the excerpts below. Explicitly point
out where papers agree, where they disagree or use incompatible assumptions,
and name any gaps the excerpts don't cover. Cite paper titles inline."""

    prompt = f"""{instructions}

QUESTION: {question}

EXCERPTS:
{context}
"""
    return llm.generate(prompt)


def ask_paper(paper_id: str, question: str, history: list[dict] | None = None) -> str:
    """Grounded Q&A on a single paper (distinct from cross-paper Synthesize):
    retrieval-scoped to just this paper, with short conversational memory."""
    hits = vectorstore.search(question, paper_ids=[paper_id], top_k=6)
    if not hits:
        return "This paper hasn't been indexed yet."

    context = "\n\n---\n\n".join(row["chunk_text"] for _score, row in hits)
    convo = ""
    if history:
        convo = "\n".join(f"{h['role'].upper()}: {h['content']}" for h in history[-6:])

    prompt = f"""Answer the question using only the excerpts from this paper
below. If the excerpts don't cover it, say so plainly instead of guessing.
Keep the answer focused and concise.

{f"PRIOR CONVERSATION:{chr(10)}{convo}{chr(10)}" if convo else ""}
QUESTION: {question}

EXCERPTS FROM THE PAPER:
{context}
"""
    return llm.generate(prompt)
