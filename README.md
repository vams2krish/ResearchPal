# ResearchPal

A local, free/open-source tool for reading dense research papers without
drowning in them. Every paper you upload is broken down into its own
**anatomy** — Title & Abstract, Introduction, Methods, Experimental Setup,
Results, Related Work, Discussion, Conclusion, References, Appendix — and
each section gets a plain-language explanation plus whatever it actually
contains: real typeset formulas, figures, tables, and code. On top of that:
an interactive mind map, a process/architecture diagram, critical claim
cards, a glossary, natural read-aloud narration, per-paper chat, and
spaced-repetition flashcards, plus a cross-paper synthesis mode, tags and
collections for organizing a large library, and a dashboard.

Everything runs on your own machine. No paid services required, and the
frontend is plain HTML/CSS/JS — no framework, no build step, nothing to
compile.

## Architecture

- **Backend**: FastAPI (`server.py`) — a thin JSON API over the same
  `core/` modules that always did the actual work (PDF parsing, the LLM
  pipeline, the vector store, spaced repetition, exports). Papers are
  processed one at a time by a single background worker thread, because
  running two LLM calls at once against one local Ollama model on modest
  hardware causes severe disk/RAM contention (see below).
- **Frontend**: `static/` — a hand-rolled single-page app (vanilla JS,
  native ES modules, hash-based routing). No React/Vue, no bundler: open
  `static/js/app.js` and it's plain, readable code end to end.
- **Data**: SQLite (`data/app.db`) + files on disk (`data/papers/<id>/`).

## How it works

- **PDF parsing**: `pymupdf4llm` (free, local) extracts text, headings,
  markdown tables, fenced code blocks, and figures (as PNG files) from PDFs.
- **Paper anatomy**: headings are detected programmatically (no LLM cost),
  then one LLM call classifies them into the canonical section list above —
  regardless of how the source paper labels its own sections ("Background"
  vs "Related Work", "Experiments" vs "Experimental Setup", etc).
- **Text generation**: your choice of backend, with automatic fallback:
  - **Gemini** (free API tier, needs a key from https://aistudio.google.com/apikey)
  - **Ollama** (fully local/offline, needs a model already pulled)
  - Set `PRIMARY_LLM` in `.env` to whichever you want to try first — if it
    fails for any reason (no key, rate limit, network down, model missing),
    the other one is used automatically.
- **Embeddings**: always local via Ollama's `nomic-embed-text-v2-moe`, so
  your library search never depends on which text-generation backend is active.
- **Vector search**: plain SQLite + numpy cosine similarity — no vector-DB
  server to run or maintain. Fine up to tens of thousands of chunks.
- **Formula rendering**: `KaTeX` (bundled locally) — real typeset math, not
  raw LaTeX source.
- **Diagrams**: `mermaid` (bundled locally) for the architecture/pathway
  diagram; `markmap` (bundled locally, built on d3) for the interactive mind
  map, where clicking a node expands/collapses it. Both fall back to a
  plain readable rendering if a browser's SVG text-measurement fails (some
  sandboxed/embedded contexts hit this — your normal desktop browser won't).
- **Original PDF**: rendered page-by-page via `pdf.js` (bundled locally, the
  engine Firefox uses) directly onto canvases — no browser PDF-plugin
  dependency, which is what makes it render reliably everywhere.
- **Read-aloud**: `edge-tts` — free, no API key, uses Microsoft's neural
  voices (the same ones behind Edge's "Read aloud"), not a robotic offline
  voice. Needs internet; audio is cached on disk so repeat listens are instant.
- **Spaced repetition**: `fsrs` (open-source FSRS scheduling algorithm).

## Setup

```bash
py -3.11 -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
copy .env.example .env
```

Edit `.env`:
- To use Gemini: paste a free key from https://aistudio.google.com/apikey into `GEMINI_API_KEY`.
- To use Ollama: make sure `ollama serve` is running and you've pulled a model,
  e.g. `ollama pull gemma4`, then set `OLLAMA_MODEL` to match.
  `OLLAMA_NUM_CTX` (default 8192) controls how much text the model actually
  sees per call — Ollama silently truncates below this regardless of the
  model's real capacity, so raise it only if you have RAM to spare.
- Either way, pull the embedding model once: `ollama pull nomic-embed-text-v2-moe`.

## Run

```bash
.venv\Scripts\activate
uvicorn server:app --port 8501
```

Opens at http://localhost:8501.

## Desktop app (Windows)

`desktop/` is an Electron shell around the same backend -- the web app *is*
the desktop app, just opened in a native window instead of a browser tab.

**Run from source** (fastest, needs the Python setup above already done):

```bash
cd desktop
npm install
npm start
```

**Build an installable .exe** (bundles its own Python -- the machine you
install it on needs nothing set up, no venv, no `pip install`):

```bash
cd desktop
npm install
npm run dist
```

This freezes the backend with PyInstaller (`npm run build:backend`, also
runnable alone) into `desktop/build/backend/`, then packages everything with
electron-builder into an NSIS installer under `desktop/dist/`. The installer
is per-user (no admin rights needed) and lets you pick the install folder.
Installed data (the paper library, database, audio cache, and `.env`) lives
under `%LOCALAPPDATA%\ResearchPal`, separate from the install
directory, and survives reinstalls/updates. Change it any time from
**Settings** in the app, which also holds the Gemini API key and Ollama
host/model -- both work exactly the same as the `.env` file above, just
editable without leaving the app.

## Using it

1. **Library** — drag-and-drop (or click) to upload PDFs; each is queued
   and processed automatically with a live progress bar per file. Organize
   with **tags** and **collections**, filter by either. Search your whole
   library from the sidebar (`/` to focus it) — combines exact keyword
   matches with semantic (embedding) search.
2. **Paper** — a two-pane reader: the left rail is the paper's anatomy
   (only sections actually present) plus analysis tools; the right pane
   shows whichever is selected.
   - Formulas render as real typeset math (KaTeX), tagged by domain
     (Math/Physics/Chemistry/Biology/CS).
   - Figures open a pan/zoom viewer on click (scroll to zoom toward the
     cursor, drag to pan, double-click to reset).
   - Tables render as real tables; code/algorithm blocks get monospace styling.
   - Each section has a checkbox to **mark it read** (tracked as a
     per-paper reading-progress bar) and a 🔊 **Listen** button with a
     voice picker.
   - **Notes** — freeform notes per section, saved immediately.
   - **Mind Map** — click any node to expand/collapse it.
   - **Diagram** — the paper's process/architecture/pathway, auto-generated.
   - **Claims** — claim/evidence/assumptions/limitations cards.
   - **Flashcards** — preview of what's in the spaced-repetition queue.
   - **Glossary** — key terms with plain-language definitions.
   - **Ask This Paper** — a chat grounded only in this paper (for comparing
     across papers, use Synthesize instead).
   - **Original PDF** — the source document, scrollable page by page.
   - Export the paper as **Markdown**, **BibTeX**, or its flashcards as an
     **Anki**-importable file, from the header.
3. **Review** — daily spaced-repetition queue (FSRS). Keyboard shortcuts:
   `Space` to reveal, `1`-`4` to rate Again/Hard/Good/Easy.
4. **Synthesize** — ask a question across some or all of your library.
   "Answer" mode retrieves relevant excerpts and explicitly calls out
   agreements/contradictions/gaps between papers (cited by title).
   "Critique" mode instead throws Socratic questions back at you, forcing
   you to do the comparing/evaluating yourself — the deliberate
   high-Bloom's-taxonomy mode instead of passive reading.
5. **Dashboard** — library-wide stats (papers, cards, reviews, claims,
   formulas), a 14-day review-activity chart, and recently added papers.
6. **Glossary** (sidebar) — every term extracted across your whole library,
   searchable in one place, linking back to its source paper.

## Why a background processing queue

Papers are processed **one at a time**, even if you upload a batch — a
single worker thread pulls from a queue. Running the LLM pipeline
concurrently for multiple papers against one local Ollama model was found
(the hard way) to cause severe contention: on modest hardware, Ollama's
model weights may live on a slow disk, and two processes reading/loading
different models at once can make both grind to a crawl or time out. If you
switch `PRIMARY_LLM` to Gemini, this stops being a constraint (the queue
still applies, but each call takes seconds instead of minutes).

## Current limitations / natural next steps

- Section classification is one LLM call across all detected headings —
  small local models can occasionally misclassify a heading, especially on
  papers with many (30+) headings. Worth a glance at the raw-text expander
  in a section if something looks oddly placed.
- Long sections get truncated (`MAX_CHARS_PER_SECTION` in `core/pipeline.py`)
  so smaller local models don't silently drop content mid-section.
- No knowledge graph yet — cross-paper structure comes from embeddings +
  metadata tags, which covers most synthesis needs without the operational
  overhead of running Neo4j.
- Flashcard/claim-card/formula quality depends on which LLM backend actually
  answered — check the sidebar's LLM status indicator; local models
  (especially smaller ones) will be noticeably weaker at math-heavy
  extraction than Gemini.
- Anki export is a plain front/back TSV (File > Import in Anki) rather than
  a ready-made `.apkg` deck — simpler, no extra dependency, but you'll pick
  the deck/note type on import yourself.
- The processing queue is in-memory — if the server restarts mid-queue,
  anything not yet started needs to be re-triggered (re-upload, or a small
  "resume incomplete papers" script would be a natural addition).
