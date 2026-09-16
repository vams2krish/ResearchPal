"""Export helpers: BibTeX citations, a Markdown report per paper, and an
Anki-importable TSV of flashcards -- turns the tool's output into things a
researcher actually carries elsewhere (a reference manager, a writeup, Anki).
"""

import re

from core import db


def _bibtex_key(title: str, year: str) -> str:
    first_word = re.sub(r"[^A-Za-z]", "", (title or "paper").split()[0] if title else "paper")
    return f"{first_word}{year or ''}"


def paper_to_bibtex(paper_id: str) -> str:
    paper = db.get_paper(paper_id)
    authors = paper["authors"] or "Unknown"
    year = paper["year"] or "n.d."
    venue = paper["venue"] or ""
    key = _bibtex_key(paper["title"], paper["year"])
    entry_type = "article" if venue else "misc"
    lines = [f"@{entry_type}{{{key},"]
    lines.append(f'  title = {{{paper["title"]}}},')
    lines.append(f"  author = {{{authors}}},")
    lines.append(f"  year = {{{year}}},")
    if venue:
        lines.append(f"  journal = {{{venue}}},")
    lines.append("}")
    return "\n".join(lines)


def paper_to_markdown(paper_id: str) -> str:
    paper = db.get_paper(paper_id)
    sections = db.get_sections(paper_id)
    equations = db.get_equations(paper_id)
    claims = db.get_claims(paper_id)
    glossary = db.get_glossary(paper_id)

    lines = [f"# {paper['title']}", ""]
    if paper["authors"] or paper["year"] or paper["venue"]:
        meta = " · ".join(x for x in (paper["authors"], paper["venue"], paper["year"]) if x)
        lines += [f"*{meta}*", ""]
    if paper["one_liner"]:
        lines += [f"> {paper['one_liner']}", ""]

    eq_by_section: dict[str, list] = {}
    for e in equations:
        eq_by_section.setdefault(e["section_name"], []).append(e)

    for s in sections:
        lines += [f"## {s['name']}", "", s["explanation"] or "*(no explanation)*", ""]
        for eq in eq_by_section.get(s["name"], []):
            lines += [f"**Formula:** `{eq['equation_raw']}`", "", eq["plain_explanation"], ""]

    if claims:
        lines += ["## Claim Cards", ""]
        for c in claims:
            lines += [
                f"- **Claim:** {c['claim']}",
                f"  - Evidence: {c['evidence']}",
                f"  - Assumptions: {c['assumptions']}",
                f"  - Limitations: {c['limitations']}",
            ]
        lines.append("")

    if glossary:
        lines += ["## Glossary", ""]
        for g in glossary:
            lines += [f"- **{g['term']}**: {g['definition']}"]
        lines.append("")

    return "\n".join(lines)


def flashcards_to_anki_tsv(paper_ids: list[str] | None = None) -> str:
    """Tab-separated front\\tback, directly importable via Anki's
    File > Import (no extra library needed for a basic two-field import)."""
    if paper_ids:
        rows = []
        for pid in paper_ids:
            rows.extend(db.get_flashcards_for_paper(pid))
    else:
        rows = []
        for p in db.list_papers():
            rows.extend(db.get_flashcards_for_paper(p["id"]))

    lines = []
    for r in rows:
        front = r["front"].replace("\t", " ").replace("\n", "<br>")
        back = r["back"].replace("\t", " ").replace("\n", "<br>")
        lines.append(f"{front}\t{back}")
    return "\n".join(lines)
