import json
import shutil
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from core import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS papers (
    id TEXT PRIMARY KEY,
    title TEXT,
    filename TEXT,
    added_at TEXT,
    full_text TEXT,
    one_liner TEXT,
    status TEXT DEFAULT 'uploaded'
);

CREATE TABLE IF NOT EXISTS sections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    paper_id TEXT REFERENCES papers(id),
    name TEXT,
    order_index INTEGER,
    raw_text TEXT,
    explanation TEXT,
    code_snippet TEXT
);

CREATE TABLE IF NOT EXISTS equations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    paper_id TEXT REFERENCES papers(id),
    section_name TEXT,
    equation_raw TEXT,
    plain_explanation TEXT,
    practical_meaning TEXT,
    domain TEXT
);

CREATE TABLE IF NOT EXISTS paper_images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    paper_id TEXT REFERENCES papers(id),
    section_name TEXT,
    file_path TEXT,
    caption TEXT
);

CREATE TABLE IF NOT EXISTS paper_tables (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    paper_id TEXT REFERENCES papers(id),
    section_name TEXT,
    markdown TEXT,
    caption TEXT
);

CREATE TABLE IF NOT EXISTS diagrams (
    paper_id TEXT PRIMARY KEY REFERENCES papers(id),
    mermaid_code TEXT
);

CREATE TABLE IF NOT EXISTS claims (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    paper_id TEXT REFERENCES papers(id),
    claim TEXT,
    evidence TEXT,
    assumptions TEXT,
    limitations TEXT
);

CREATE TABLE IF NOT EXISTS first_principles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    paper_id TEXT REFERENCES papers(id),
    order_index INTEGER,
    statement TEXT
);

CREATE TABLE IF NOT EXISTS flashcards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    paper_id TEXT REFERENCES papers(id),
    card_type TEXT,
    front TEXT,
    back TEXT,
    fsrs_card TEXT
);

CREATE TABLE IF NOT EXISTS review_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    flashcard_id INTEGER REFERENCES flashcards(id),
    rating INTEGER,
    reviewed_at TEXT
);

CREATE TABLE IF NOT EXISTS chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    paper_id TEXT REFERENCES papers(id),
    chunk_text TEXT,
    embedding BLOB
);

CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    paper_id TEXT REFERENCES papers(id),
    section_name TEXT,
    content TEXT,
    created_at TEXT,
    updated_at TEXT
);

CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE COLLATE NOCASE
);

CREATE TABLE IF NOT EXISTS paper_tags (
    paper_id TEXT REFERENCES papers(id),
    tag_id INTEGER REFERENCES tags(id),
    PRIMARY KEY (paper_id, tag_id)
);

CREATE TABLE IF NOT EXISTS collections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE COLLATE NOCASE,
    created_at TEXT
);

CREATE TABLE IF NOT EXISTS paper_collections (
    paper_id TEXT REFERENCES papers(id),
    collection_id INTEGER REFERENCES collections(id),
    PRIMARY KEY (paper_id, collection_id)
);

CREATE TABLE IF NOT EXISTS glossary (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    paper_id TEXT REFERENCES papers(id),
    term TEXT,
    definition TEXT
);

CREATE TABLE IF NOT EXISTS mental_models (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE COLLATE NOCASE,
    description TEXT
);

CREATE TABLE IF NOT EXISTS paper_mental_models (
    paper_id TEXT REFERENCES papers(id),
    model_id INTEGER REFERENCES mental_models(id),
    note TEXT DEFAULT '',
    PRIMARY KEY (paper_id, model_id)
);

CREATE TABLE IF NOT EXISTS human_notes (
    paper_id TEXT PRIMARY KEY REFERENCES papers(id),
    content TEXT DEFAULT '',
    updated_at TEXT
);

CREATE TABLE IF NOT EXISTS pdf_highlights (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    paper_id TEXT REFERENCES papers(id),
    page_number INTEGER,
    start_offset INTEGER,
    end_offset INTEGER,
    snippet TEXT,
    color TEXT DEFAULT 'yellow',
    note TEXT DEFAULT '',
    created_at TEXT
);

CREATE TABLE IF NOT EXISTS research_sessions (
    id TEXT PRIMARY KEY,
    paper_ids TEXT,
    title TEXT,
    created_at TEXT
);

CREATE TABLE IF NOT EXISTS research_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT REFERENCES research_sessions(id),
    role TEXT,
    content TEXT,
    sources TEXT,
    steps TEXT,
    created_at TEXT
);

CREATE TABLE IF NOT EXISTS paper_chats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    paper_id TEXT REFERENCES papers(id),
    role TEXT,
    content TEXT,
    created_at TEXT
);

CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT,
    description TEXT,
    paper_id TEXT,
    created_at TEXT
);
"""

# A starting vocabulary of well-known cross-domain mental models/frameworks,
# so tagging a paper is picking from a curated list (with LLM-assisted
# suggestions) rather than starting from a blank page. Users can still add
# their own -- new names just get created on first use, same as tags.
CANONICAL_MENTAL_MODELS = [
    ("Reinforcing Feedback Loop", "A change that amplifies itself further in the same direction, compounding over time."),
    ("Balancing Feedback Loop", "A change that triggers a counteracting force pulling the system back toward equilibrium."),
    ("Stocks and Flows", "Distinguishing accumulated quantities (stocks) from the rates that change them (flows) -- the core vocabulary of systems dynamics."),
    ("Leverage Points", "Places in a system where a small, well-placed change produces a disproportionately large effect."),
    ("Second-Order Thinking", "Tracing the consequences of a consequence, not just the immediate first-order effect of an action."),
    ("Emergence", "System-level behavior that arises from component interactions and isn't predictable from any single component alone."),
    ("Power Law / Pareto Principle", "A small number of causes or entities account for a disproportionate share of the effect or total."),
    ("Scaling Laws", "Performance or behavior changes predictably (often as a power law) with a controlled variable like size, data, or compute."),
    ("Path Dependence", "Early choices constrain what's reachable later, even after the original reasons for them stop applying."),
    ("Tipping Point / Threshold Effect", "A system stays qualitatively stable until a critical value is crossed, after which behavior changes abruptly."),
    ("Network Effects", "A system's value or behavior changes with the number and structure of connections between its parts."),
    ("Bayesian Updating", "Revising a belief's probability incrementally as new evidence arrives, rather than treating conclusions as fixed."),
    ("Regression to the Mean", "Extreme observations tend to be followed by more typical ones, absent a genuine underlying cause."),
    ("Survivorship Bias", "Conclusions drawn only from what remained observable, ignoring cases that were filtered out or didn't survive."),
    ("Confirmation Bias", "Evidence is sought, weighted, or interpreted in a way that favors an existing belief or hypothesis."),
    ("Occam's Razor", "Among explanations that fit the evidence equally well, the simplest one is preferred."),
    ("Inversion", "Approaching a problem by considering how to cause the failure state, then avoiding those paths."),
    ("Marginal Analysis", "Decisions are evaluated by the effect of one additional unit of input/effort, not the average or total."),
    ("Opportunity Cost", "The true cost of a choice includes the value of the next-best alternative that was given up."),
    ("Compounding", "Small effects accumulate multiplicatively over repeated iterations, producing outsized long-run outcomes."),
    ("Signal vs. Noise", "Separating the reliable, repeatable pattern in data from random or irrelevant variation."),
    ("Antifragility", "A system that doesn't just resist disorder/stress but improves in capability because of exposure to it."),
    ("Red Queen Dynamics", "Competing entities must keep adapting just to maintain their relative position, as rivals adapt too."),
    ("First-Principles Reasoning", "Breaking a problem down to foundational truths and reasoning up, instead of reasoning by analogy to existing solutions."),
]

# Additive migrations for columns added after the original CREATE TABLE --
# kept separate from SCHEMA so existing papers (already processed, often
# after a slow local-model run) don't have to be wiped and reprocessed
# every time the schema grows.
MIGRATIONS = [
    ("papers", "authors", "ALTER TABLE papers ADD COLUMN authors TEXT"),
    ("papers", "year", "ALTER TABLE papers ADD COLUMN year TEXT"),
    ("papers", "venue", "ALTER TABLE papers ADD COLUMN venue TEXT"),
    ("sections", "is_read", "ALTER TABLE sections ADD COLUMN is_read INTEGER DEFAULT 0"),
    ("papers", "is_favorite", "ALTER TABLE papers ADD COLUMN is_favorite INTEGER DEFAULT 0"),
]


@contextmanager
def get_conn():
    conn = sqlite3.connect(config.DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db():
    with get_conn() as conn:
        conn.executescript(SCHEMA)
        for _table, _col, alter_sql in MIGRATIONS:
            try:
                conn.execute(alter_sql)
            except sqlite3.OperationalError:
                pass  # column already exists
        for name, description in CANONICAL_MENTAL_MODELS:
            conn.execute("INSERT OR IGNORE INTO mental_models (name, description) VALUES (?, ?)", (name, description))


def new_id() -> str:
    return uuid.uuid4().hex[:12]


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def image_dir_for(paper_id: str) -> Path:
    d = config.PAPERS_DIR / paper_id / "images"
    d.mkdir(parents=True, exist_ok=True)
    return d


def add_paper(paper_id: str, title: str, filename: str, full_text: str) -> str:
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO papers (id, title, filename, added_at, full_text, status) "
            "VALUES (?, ?, ?, ?, ?, 'uploaded')",
            (paper_id, title, filename, now(), full_text),
        )
    return paper_id


def set_paper_status(paper_id: str, status: str):
    with get_conn() as conn:
        conn.execute("UPDATE papers SET status = ? WHERE id = ?", (status, paper_id))


def set_paper_one_liner(paper_id: str, one_liner: str):
    with get_conn() as conn:
        conn.execute("UPDATE papers SET one_liner = ? WHERE id = ?", (one_liner, paper_id))


def set_paper_metadata(paper_id: str, authors: str = None, year: str = None, venue: str = None, title: str = None):
    with get_conn() as conn:
        if title:
            conn.execute(
                "UPDATE papers SET authors = ?, year = ?, venue = ?, title = ? WHERE id = ?",
                (authors, year, venue, title, paper_id),
            )
        else:
            conn.execute(
                "UPDATE papers SET authors = ?, year = ?, venue = ? WHERE id = ?",
                (authors, year, venue, paper_id),
            )


def set_paper_filename(paper_id: str, filename: str):
    with get_conn() as conn:
        conn.execute("UPDATE papers SET filename = ? WHERE id = ?", (filename, paper_id))


def set_paper_favorite(paper_id: str, is_favorite: bool):
    with get_conn() as conn:
        conn.execute("UPDATE papers SET is_favorite = ? WHERE id = ?", (1 if is_favorite else 0, paper_id))


def list_papers():
    with get_conn() as conn:
        rows = conn.execute(
            """SELECT p.id, p.title, p.filename, p.added_at, p.status, p.one_liner,
                      p.authors, p.year, p.venue, p.is_favorite,
                      (SELECT GROUP_CONCAT(t.name, ',') FROM paper_tags pt
                       JOIN tags t ON t.id = pt.tag_id WHERE pt.paper_id = p.id) as tag_names
               FROM papers p ORDER BY added_at DESC"""
        ).fetchall()
    return rows


def get_paper(paper_id: str):
    with get_conn() as conn:
        return conn.execute("SELECT * FROM papers WHERE id = ?", (paper_id,)).fetchone()


def delete_paper(paper_id: str):
    with get_conn() as conn:
        conn.execute(
            "DELETE FROM review_log WHERE flashcard_id IN "
            "(SELECT id FROM flashcards WHERE paper_id = ?)",
            (paper_id,),
        )
        conn.execute("DELETE FROM paper_tags WHERE paper_id = ?", (paper_id,))
        conn.execute("DELETE FROM paper_collections WHERE paper_id = ?", (paper_id,))
        conn.execute("DELETE FROM paper_mental_models WHERE paper_id = ?", (paper_id,))
        for table in (
            "sections", "equations", "claims", "first_principles", "flashcards", "chunks",
            "diagrams", "paper_images", "paper_tables", "notes", "glossary",
            "human_notes", "pdf_highlights", "paper_chats", "papers",
        ):
            conn.execute(f"DELETE FROM {table} WHERE {'id' if table == 'papers' else 'paper_id'} = ?", (paper_id,))
    paper_dir = config.PAPERS_DIR / paper_id
    if paper_dir.exists():
        shutil.rmtree(paper_dir, ignore_errors=True)


def save_sections(paper_id: str, sections: list[dict]):
    with get_conn() as conn:
        conn.execute("DELETE FROM sections WHERE paper_id = ?", (paper_id,))
        for i, s in enumerate(sections):
            conn.execute(
                "INSERT INTO sections (paper_id, name, order_index, raw_text, explanation, code_snippet) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (paper_id, s["name"], i, s.get("raw_text", ""), s.get("explanation", ""), s.get("code_snippet")),
            )


def get_sections(paper_id: str):
    with get_conn() as conn:
        return conn.execute(
            "SELECT * FROM sections WHERE paper_id = ? ORDER BY order_index", (paper_id,)
        ).fetchall()


def save_equations(paper_id: str, equations: list[dict]):
    with get_conn() as conn:
        conn.execute("DELETE FROM equations WHERE paper_id = ?", (paper_id,))
        for eq in equations:
            conn.execute(
                "INSERT INTO equations (paper_id, section_name, equation_raw, plain_explanation, practical_meaning, domain) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (
                    paper_id,
                    eq.get("section_name", "Other"),
                    eq.get("equation_raw", ""),
                    eq.get("plain_explanation", ""),
                    eq.get("practical_meaning", ""),
                    eq.get("domain", "Other"),
                ),
            )


def get_equations(paper_id: str):
    with get_conn() as conn:
        return conn.execute(
            "SELECT * FROM equations WHERE paper_id = ?", (paper_id,)
        ).fetchall()


def save_paper_images(paper_id: str, images: list[dict]):
    with get_conn() as conn:
        conn.execute("DELETE FROM paper_images WHERE paper_id = ?", (paper_id,))
        for img in images:
            conn.execute(
                "INSERT INTO paper_images (paper_id, section_name, file_path, caption) VALUES (?, ?, ?, ?)",
                (paper_id, img.get("section_name", "Other"), img["file_path"], img.get("caption", "")),
            )


def get_images(paper_id: str):
    with get_conn() as conn:
        return conn.execute(
            "SELECT * FROM paper_images WHERE paper_id = ?", (paper_id,)
        ).fetchall()


def save_paper_tables(paper_id: str, tables: list[dict]):
    with get_conn() as conn:
        conn.execute("DELETE FROM paper_tables WHERE paper_id = ?", (paper_id,))
        for t in tables:
            conn.execute(
                "INSERT INTO paper_tables (paper_id, section_name, markdown, caption) VALUES (?, ?, ?, ?)",
                (paper_id, t.get("section_name", "Other"), t["markdown"], t.get("caption", "")),
            )


def get_tables(paper_id: str):
    with get_conn() as conn:
        return conn.execute(
            "SELECT * FROM paper_tables WHERE paper_id = ?", (paper_id,)
        ).fetchall()


def save_diagram(paper_id: str, mermaid_code: str):
    with get_conn() as conn:
        conn.execute("DELETE FROM diagrams WHERE paper_id = ?", (paper_id,))
        if mermaid_code:
            conn.execute(
                "INSERT INTO diagrams (paper_id, mermaid_code) VALUES (?, ?)",
                (paper_id, mermaid_code),
            )


def get_diagram(paper_id: str):
    with get_conn() as conn:
        return conn.execute(
            "SELECT * FROM diagrams WHERE paper_id = ?", (paper_id,)
        ).fetchone()


def save_claims(paper_id: str, claims: list[dict]):
    with get_conn() as conn:
        conn.execute("DELETE FROM claims WHERE paper_id = ?", (paper_id,))
        for c in claims:
            conn.execute(
                "INSERT INTO claims (paper_id, claim, evidence, assumptions, limitations) "
                "VALUES (?, ?, ?, ?, ?)",
                (
                    paper_id,
                    c.get("claim", ""),
                    c.get("evidence", ""),
                    c.get("assumptions", ""),
                    c.get("limitations", ""),
                ),
            )


def get_claims(paper_id: str):
    with get_conn() as conn:
        return conn.execute(
            "SELECT * FROM claims WHERE paper_id = ?", (paper_id,)
        ).fetchall()


def save_first_principles(paper_id: str, statements: list[str]):
    with get_conn() as conn:
        conn.execute("DELETE FROM first_principles WHERE paper_id = ?", (paper_id,))
        for i, statement in enumerate(statements):
            conn.execute(
                "INSERT INTO first_principles (paper_id, order_index, statement) VALUES (?, ?, ?)",
                (paper_id, i, statement),
            )


def get_first_principles(paper_id: str):
    with get_conn() as conn:
        return conn.execute(
            "SELECT * FROM first_principles WHERE paper_id = ? ORDER BY order_index", (paper_id,)
        ).fetchall()


def save_flashcards(paper_id: str, cards: list[dict]):
    from fsrs import Card

    with get_conn() as conn:
        conn.execute("DELETE FROM flashcards WHERE paper_id = ?", (paper_id,))
        for c in cards:
            fresh = Card()
            conn.execute(
                "INSERT INTO flashcards (paper_id, card_type, front, back, fsrs_card) "
                "VALUES (?, ?, ?, ?, ?)",
                (
                    paper_id,
                    c.get("card_type", "fact"),
                    c.get("front", ""),
                    c.get("back", ""),
                    json.dumps(fresh.to_dict()),
                ),
            )


def get_flashcards_for_paper(paper_id: str):
    with get_conn() as conn:
        return conn.execute(
            "SELECT * FROM flashcards WHERE paper_id = ?", (paper_id,)
        ).fetchall()


def get_due_flashcards(limit: int = 20):
    with get_conn() as conn:
        rows = conn.execute(
            """SELECT f.*, p.title as paper_title FROM flashcards f
               JOIN papers p ON p.id = f.paper_id"""
        ).fetchall()

    from fsrs import Card

    due = []
    now_dt = datetime.now(timezone.utc)
    for row in rows:
        card = Card.from_dict(json.loads(row["fsrs_card"]))
        if card.due <= now_dt:
            due.append(row)
    return due[:limit]


def count_due_flashcards() -> int:
    return len(get_due_flashcards(limit=10_000))


def update_flashcard_fsrs(flashcard_id: int, card_dict: dict, rating: int):
    with get_conn() as conn:
        conn.execute(
            "UPDATE flashcards SET fsrs_card = ? WHERE id = ?",
            (json.dumps(card_dict), flashcard_id),
        )
        conn.execute(
            "INSERT INTO review_log (flashcard_id, rating, reviewed_at) VALUES (?, ?, ?)",
            (flashcard_id, rating, now()),
        )


def save_chunks(paper_id: str, chunks: list[str], embeddings: list[list[float]]):
    import numpy as np

    with get_conn() as conn:
        conn.execute("DELETE FROM chunks WHERE paper_id = ?", (paper_id,))
        for text, emb in zip(chunks, embeddings):
            blob = np.array(emb, dtype=np.float32).tobytes()
            conn.execute(
                "INSERT INTO chunks (paper_id, chunk_text, embedding) VALUES (?, ?, ?)",
                (paper_id, text, blob),
            )


def get_all_chunks(paper_ids: list[str] | None = None):
    with get_conn() as conn:
        if paper_ids:
            placeholders = ",".join("?" * len(paper_ids))
            rows = conn.execute(
                f"""SELECT c.*, p.title as paper_title FROM chunks c
                    JOIN papers p ON p.id = c.paper_id
                    WHERE c.paper_id IN ({placeholders})""",
                paper_ids,
            ).fetchall()
        else:
            rows = conn.execute(
                """SELECT c.*, p.title as paper_title FROM chunks c
                   JOIN papers p ON p.id = c.paper_id"""
            ).fetchall()
    return rows


# ------------------------------------------------------------- Reading progress
def set_section_read(section_id: int, is_read: bool):
    with get_conn() as conn:
        conn.execute("UPDATE sections SET is_read = ? WHERE id = ?", (1 if is_read else 0, section_id))


def paper_read_progress(paper_id: str) -> dict:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT COUNT(*) as total, SUM(is_read) as done FROM sections WHERE paper_id = ?", (paper_id,)
        ).fetchone()
    total = row["total"] or 0
    done = row["done"] or 0
    return {"total": total, "done": done, "pct": round(100 * done / total) if total else 0}


# ------------------------------------------------------------------------ Notes
def add_note(paper_id: str, section_name: str, content: str) -> int:
    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO notes (paper_id, section_name, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            (paper_id, section_name, content, now(), now()),
        )
        return cur.lastrowid


def update_note(note_id: int, content: str):
    with get_conn() as conn:
        conn.execute("UPDATE notes SET content = ?, updated_at = ? WHERE id = ?", (content, now(), note_id))


def delete_note(note_id: int):
    with get_conn() as conn:
        conn.execute("DELETE FROM notes WHERE id = ?", (note_id,))


def get_notes(paper_id: str, section_name: str | None = None):
    with get_conn() as conn:
        if section_name:
            return conn.execute(
                "SELECT * FROM notes WHERE paper_id = ? AND section_name = ? ORDER BY created_at",
                (paper_id, section_name),
            ).fetchall()
        return conn.execute(
            "SELECT * FROM notes WHERE paper_id = ? ORDER BY created_at", (paper_id,)
        ).fetchall()


# --------------------------------------------------------- Human written notes
def get_human_notes(paper_id: str) -> dict:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT content, updated_at FROM human_notes WHERE paper_id = ?", (paper_id,)
        ).fetchone()
    return {"content": row["content"], "updated_at": row["updated_at"]} if row else {"content": "", "updated_at": None}


def save_human_notes(paper_id: str, content: str):
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO human_notes (paper_id, content, updated_at) VALUES (?, ?, ?) "
            "ON CONFLICT(paper_id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at",
            (paper_id, content, now()),
        )


# ------------------------------------------------------------------ PDF highlights
def get_highlights(paper_id: str):
    with get_conn() as conn:
        return conn.execute(
            "SELECT * FROM pdf_highlights WHERE paper_id = ? ORDER BY page_number, start_offset", (paper_id,)
        ).fetchall()


def add_highlight(paper_id: str, page_number: int, start_offset: int, end_offset: int, snippet: str, color: str = "yellow") -> int:
    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO pdf_highlights (paper_id, page_number, start_offset, end_offset, snippet, color, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (paper_id, page_number, start_offset, end_offset, snippet, color, now()),
        )
        return cur.lastrowid


def delete_highlight(highlight_id: int):
    with get_conn() as conn:
        conn.execute("DELETE FROM pdf_highlights WHERE id = ?", (highlight_id,))


# ------------------------------------------------------------------- Tags
def get_or_create_tag(name: str) -> int:
    name = name.strip()
    with get_conn() as conn:
        row = conn.execute("SELECT id FROM tags WHERE name = ?", (name,)).fetchone()
        if row:
            return row["id"]
        cur = conn.execute("INSERT INTO tags (name) VALUES (?)", (name,))
        return cur.lastrowid


def add_tag_to_paper(paper_id: str, tag_name: str):
    tag_id = get_or_create_tag(tag_name)
    with get_conn() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO paper_tags (paper_id, tag_id) VALUES (?, ?)", (paper_id, tag_id)
        )


def remove_tag_from_paper(paper_id: str, tag_name: str):
    with get_conn() as conn:
        conn.execute(
            "DELETE FROM paper_tags WHERE paper_id = ? AND tag_id = "
            "(SELECT id FROM tags WHERE name = ?)",
            (paper_id, tag_name),
        )


def list_all_tags():
    with get_conn() as conn:
        return conn.execute(
            """SELECT t.name, COUNT(pt.paper_id) as paper_count FROM tags t
               LEFT JOIN paper_tags pt ON pt.tag_id = t.id
               GROUP BY t.id ORDER BY t.name COLLATE NOCASE"""
        ).fetchall()


def get_tags_for_paper(paper_id: str) -> list[str]:
    with get_conn() as conn:
        rows = conn.execute(
            """SELECT t.name FROM tags t JOIN paper_tags pt ON pt.tag_id = t.id
               WHERE pt.paper_id = ? ORDER BY t.name COLLATE NOCASE""",
            (paper_id,),
        ).fetchall()
    return [r["name"] for r in rows]


# ------------------------------------------------------------------ Collections
def create_collection(name: str) -> int:
    with get_conn() as conn:
        cur = conn.execute(
            "INSERT OR IGNORE INTO collections (name, created_at) VALUES (?, ?)", (name.strip(), now())
        )
        row = conn.execute("SELECT id FROM collections WHERE name = ?", (name.strip(),)).fetchone()
        return row["id"]


def delete_collection(collection_id: int):
    with get_conn() as conn:
        conn.execute("DELETE FROM paper_collections WHERE collection_id = ?", (collection_id,))
        conn.execute("DELETE FROM collections WHERE id = ?", (collection_id,))


def add_paper_to_collection(paper_id: str, collection_id: int):
    with get_conn() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO paper_collections (paper_id, collection_id) VALUES (?, ?)",
            (paper_id, collection_id),
        )


def remove_paper_from_collection(paper_id: str, collection_id: int):
    with get_conn() as conn:
        conn.execute(
            "DELETE FROM paper_collections WHERE paper_id = ? AND collection_id = ?",
            (paper_id, collection_id),
        )


def list_collections():
    with get_conn() as conn:
        return conn.execute(
            """SELECT c.id, c.name, COUNT(pc.paper_id) as paper_count FROM collections c
               LEFT JOIN paper_collections pc ON pc.collection_id = c.id
               GROUP BY c.id ORDER BY c.name COLLATE NOCASE"""
        ).fetchall()


def get_papers_in_collection(collection_id: int):
    with get_conn() as conn:
        return conn.execute(
            """SELECT p.id, p.title, p.one_liner, p.status FROM papers p
               JOIN paper_collections pc ON pc.paper_id = p.id
               WHERE pc.collection_id = ? ORDER BY p.added_at DESC""",
            (collection_id,),
        ).fetchall()


# --------------------------------------------------------------------- Glossary
def save_glossary(paper_id: str, terms: list[dict]):
    with get_conn() as conn:
        conn.execute("DELETE FROM glossary WHERE paper_id = ?", (paper_id,))
        for t in terms:
            conn.execute(
                "INSERT INTO glossary (paper_id, term, definition) VALUES (?, ?, ?)",
                (paper_id, t.get("term", ""), t.get("definition", "")),
            )


def get_glossary(paper_id: str):
    with get_conn() as conn:
        return conn.execute(
            "SELECT * FROM glossary WHERE paper_id = ? ORDER BY term COLLATE NOCASE", (paper_id,)
        ).fetchall()


def search_glossary(query: str):
    with get_conn() as conn:
        return conn.execute(
            """SELECT g.*, p.title as paper_title FROM glossary g
               JOIN papers p ON p.id = g.paper_id
               WHERE g.term LIKE ? OR g.definition LIKE ?
               ORDER BY g.term COLLATE NOCASE LIMIT 50""",
            (f"%{query}%", f"%{query}%"),
        ).fetchall()


def list_concepts() -> list[dict]:
    """Invert the per-paper glossary into a cross-library concept index:
    one entry per distinct term (case-insensitive), each listing every paper
    that defines it and how that paper's definition reads -- lets a term that
    recurs across papers surface definition drift instead of being buried
    inside each paper's own tab. Sorted by how many papers share the term."""
    with get_conn() as conn:
        rows = conn.execute(
            """SELECT g.term, g.definition, g.paper_id, p.title as paper_title
               FROM glossary g JOIN papers p ON p.id = g.paper_id
               ORDER BY g.term COLLATE NOCASE"""
        ).fetchall()
    concepts: dict[str, dict] = {}
    for r in rows:
        key = r["term"].strip().lower()
        if key not in concepts:
            concepts[key] = {"term": r["term"].strip(), "papers": []}
        concepts[key]["papers"].append(
            {"paper_id": r["paper_id"], "paper_title": r["paper_title"], "definition": r["definition"]}
        )
    return sorted(concepts.values(), key=lambda c: (-len(c["papers"]), c["term"].lower()))


# --------------------------------------------------------------- Mental models
def list_mental_models():
    with get_conn() as conn:
        return conn.execute(
            """SELECT m.id, m.name, m.description, COUNT(pm.paper_id) as paper_count
               FROM mental_models m
               LEFT JOIN paper_mental_models pm ON pm.model_id = m.id
               GROUP BY m.id ORDER BY m.name COLLATE NOCASE"""
        ).fetchall()


def get_or_create_mental_model(name: str, description: str = "") -> int:
    name = name.strip()
    with get_conn() as conn:
        row = conn.execute("SELECT id FROM mental_models WHERE name = ?", (name,)).fetchone()
        if row:
            return row["id"]
        cur = conn.execute("INSERT INTO mental_models (name, description) VALUES (?, ?)", (name, description))
        return cur.lastrowid


def add_mental_model_to_paper(paper_id: str, name: str, note: str = "", description: str = "") -> int:
    model_id = get_or_create_mental_model(name, description)
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO paper_mental_models (paper_id, model_id, note) VALUES (?, ?, ?) "
            "ON CONFLICT(paper_id, model_id) DO UPDATE SET note = excluded.note",
            (paper_id, model_id, note),
        )
    return model_id


def remove_mental_model_from_paper(paper_id: str, model_id: int):
    with get_conn() as conn:
        conn.execute(
            "DELETE FROM paper_mental_models WHERE paper_id = ? AND model_id = ?", (paper_id, model_id)
        )


def get_mental_models_for_paper(paper_id: str):
    with get_conn() as conn:
        return conn.execute(
            """SELECT m.id, m.name, m.description, pm.note FROM paper_mental_models pm
               JOIN mental_models m ON m.id = pm.model_id
               WHERE pm.paper_id = ? ORDER BY m.name COLLATE NOCASE""",
            (paper_id,),
        ).fetchall()


def get_papers_for_mental_model(model_id: int):
    with get_conn() as conn:
        return conn.execute(
            """SELECT p.id, p.title, p.one_liner, pm.note FROM paper_mental_models pm
               JOIN papers p ON p.id = pm.paper_id
               WHERE pm.model_id = ? ORDER BY p.added_at DESC""",
            (model_id,),
        ).fetchall()


# ----------------------------------------------------------------------- Search
def keyword_search(query: str, limit: int = 30):
    """Simple LIKE-based search across titles, section text, and claims --
    complements the semantic vector search for exact terms/names/acronyms
    that embeddings sometimes blur together."""
    like = f"%{query}%"
    with get_conn() as conn:
        title_hits = conn.execute(
            "SELECT id as paper_id, title, one_liner FROM papers WHERE title LIKE ? OR one_liner LIKE ?",
            (like, like),
        ).fetchall()
        section_hits = conn.execute(
            """SELECT s.paper_id, p.title, s.name as section_name, s.explanation FROM sections s
               JOIN papers p ON p.id = s.paper_id
               WHERE s.explanation LIKE ? OR s.raw_text LIKE ? LIMIT ?""",
            (like, like, limit),
        ).fetchall()
    return {"papers": title_hits, "sections": section_hits}


# --------------------------------------------------------------------- Dashboard
def dashboard_stats() -> dict:
    with get_conn() as conn:
        total_papers = conn.execute("SELECT COUNT(*) c FROM papers").fetchone()["c"]
        processed = conn.execute("SELECT COUNT(*) c FROM papers WHERE status = 'processed'").fetchone()["c"]
        total_cards = conn.execute("SELECT COUNT(*) c FROM flashcards").fetchone()["c"]
        reviews_done = conn.execute("SELECT COUNT(*) c FROM review_log").fetchone()["c"]
        total_claims = conn.execute("SELECT COUNT(*) c FROM claims").fetchone()["c"]
        total_equations = conn.execute("SELECT COUNT(*) c FROM equations").fetchone()["c"]
        recent = conn.execute(
            "SELECT id, title, added_at, status FROM papers ORDER BY added_at DESC LIMIT 5"
        ).fetchall()
        reviews_by_day = conn.execute(
            """SELECT substr(reviewed_at, 1, 10) as day, COUNT(*) as n FROM review_log
               GROUP BY day ORDER BY day DESC LIMIT 14"""
        ).fetchall()
    return {
        "total_papers": total_papers,
        "processed": processed,
        "total_cards": total_cards,
        "reviews_done": reviews_done,
        "total_claims": total_claims,
        "total_equations": total_equations,
        "recent": recent,
        "reviews_by_day": reviews_by_day,
    }


# ----------------------------------------------------------------- Deep Research
def create_research_session(paper_ids: list[str], title: str) -> str:
    session_id = new_id()
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO research_sessions (id, paper_ids, title, created_at) VALUES (?, ?, ?, ?)",
            (session_id, json.dumps(paper_ids), title, now()),
        )
    return session_id


def list_research_sessions():
    with get_conn() as conn:
        rows = conn.execute("SELECT * FROM research_sessions ORDER BY created_at DESC").fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["paper_ids"] = json.loads(d["paper_ids"] or "[]")
        out.append(d)
    return out


def get_research_session(session_id: str):
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM research_sessions WHERE id = ?", (session_id,)).fetchone()
    if not row:
        return None
    d = dict(row)
    d["paper_ids"] = json.loads(d["paper_ids"] or "[]")
    return d


def delete_research_session(session_id: str):
    with get_conn() as conn:
        conn.execute("DELETE FROM research_messages WHERE session_id = ?", (session_id,))
        conn.execute("DELETE FROM research_sessions WHERE id = ?", (session_id,))


def add_research_message(session_id: str, role: str, content: str, sources: list | None = None, steps: list | None = None) -> int:
    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO research_messages (session_id, role, content, sources, steps, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (session_id, role, content, json.dumps(sources or []), json.dumps(steps or []), now()),
        )
        return cur.lastrowid


def get_research_messages(session_id: str):
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM research_messages WHERE session_id = ? ORDER BY created_at", (session_id,)
        ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["sources"] = json.loads(d["sources"] or "[]")
        d["steps"] = json.loads(d["steps"] or "[]")
        out.append(d)
    return out


# ------------------------------------------------------- Ask This Paper chat
def add_chat_message(paper_id: str, role: str, content: str) -> int:
    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO paper_chats (paper_id, role, content, created_at) VALUES (?, ?, ?, ?)",
            (paper_id, role, content, now()),
        )
        return cur.lastrowid


def get_chat_messages(paper_id: str):
    with get_conn() as conn:
        return conn.execute(
            "SELECT * FROM paper_chats WHERE paper_id = ? ORDER BY created_at", (paper_id,)
        ).fetchall()


# ------------------------------------------------------------- Activity log
def log_activity(event_type: str, description: str, paper_id: str | None = None):
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO activity_log (event_type, description, paper_id, created_at) VALUES (?, ?, ?, ?)",
            (event_type, description, paper_id, now()),
        )


def get_recent_activity(limit: int = 50):
    with get_conn() as conn:
        return conn.execute(
            "SELECT * FROM activity_log ORDER BY created_at DESC LIMIT ?", (limit,)
        ).fetchall()
