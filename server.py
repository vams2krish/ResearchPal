"""FastAPI backend for ResearchPal.

Replaces the old Streamlit app entirely: this is a thin HTTP/JSON layer over
the same core/ modules (db, pipeline, llm, audio, export, vectorstore) --
none of that business logic changed. The frontend is a static HTML/CSS/JS
single-page app served from static/.

Papers are processed one at a time by a single background worker thread
(not per-request), because concurrent LLM calls against one local Ollama
model on modest hardware causes severe disk/RAM contention (see README) --
queuing keeps the whole thing reliable regardless of how many files land at
once.
"""

import json
import os
import queue
import shutil
import threading
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, PlainTextResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from core import anatomy, audio, config, db, export, llm, pdf_parser, pipeline, research, scheduler, vectorstore
from fsrs import Rating

db.init_db()

app = FastAPI(title="ResearchPal")
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)

# ------------------------------------------------------------- Static/media
STATIC_DIR = config.ROOT_DIR / "static"
app.mount("/assets", StaticFiles(directory=str(config.ROOT_DIR / "assets")), name="assets")
app.mount("/media/papers", StaticFiles(directory=str(config.PAPERS_DIR)), name="paper_media")
app.mount("/media/audio", StaticFiles(directory=str(audio.AUDIO_DIR)), name="audio_media")
app.mount("/app", StaticFiles(directory=str(STATIC_DIR), html=True), name="app")


@app.middleware("http")
async def no_cache_app_assets(request, call_next):
    # Same reasoning as the explicit no-cache on "/" below: browsers can keep
    # serving a stale JS/CSS bundle from disk cache across restarts/updates
    # even on a normal reload, silently hiding real changes.
    response = await call_next(request)
    if request.url.path.startswith("/app/"):
        response.headers["Cache-Control"] = "no-cache"
    return response


@app.get("/")
def index():
    # This SPA shell embeds the sidebar nav directly, unlike the JS modules
    # which import fresh -- without an explicit no-cache, browsers can keep
    # serving a stale sidebar (missing newly added nav links) from disk cache
    # across restarts/updates, even on a normal navigation/reload.
    return FileResponse(str(STATIC_DIR / "index.html"), headers={"Cache-Control": "no-cache"})


# Served from root scope (not under /app/) -- the manifest's implied scope is
# its own directory, and iOS/Android both expect the service worker's scope
# to cover the whole origin, not just /app/.
@app.get("/manifest.json")
def manifest():
    return FileResponse(str(STATIC_DIR / "manifest.json"), media_type="application/manifest+json")


@app.get("/sw.js")
def service_worker():
    return FileResponse(str(STATIC_DIR / "sw.js"), media_type="application/javascript", headers={"Cache-Control": "no-cache"})


def media_url(abs_path: str) -> str:
    """Absolute filesystem path under data/papers/ -> a URL the frontend can load."""
    try:
        rel = Path(abs_path).relative_to(config.PAPERS_DIR)
    except ValueError:
        return ""
    return f"/media/papers/{rel.as_posix()}"


# --------------------------------------------------------- Processing queue
_work_queue: "queue.Queue[str]" = queue.Queue()
_progress_queues: dict[str, "queue.Queue[str]"] = {}


def _worker():
    while True:
        paper_id = _work_queue.get()
        q = _progress_queues.setdefault(paper_id, queue.Queue())
        paper = db.get_paper(paper_id)
        if not paper:
            continue
        try:
            pipeline.process_paper(paper_id, paper["title"], paper["full_text"], progress_cb=q.put)
            q.put("__DONE__")
            db.log_activity("paper_processed", f'Processed "{paper["title"]}"', paper_id)
        except Exception as e:  # noqa: BLE001 - surface to the client, don't crash the worker
            q.put(f"__ERROR__:{e}")


threading.Thread(target=_worker, daemon=True).start()

# The queue above is in-memory only -- if the server restarts (a code change,
# a crash) while papers are sitting at status='uploaded' waiting their turn,
# they'd otherwise be silently orphaned forever with no error and no way to
# tell from the UI. Requeue anything left unprocessed on every startup.
for _p in db.list_papers():
    if _p["status"] == "uploaded":
        _progress_queues[_p["id"]] = queue.Queue()
        _work_queue.put(_p["id"])


# ------------------------------------------------------------------ Papers
def _paper_dict(row) -> dict:
    d = dict(row)
    d["tags"] = (d.pop("tag_names", "") or "").split(",") if d.get("tag_names") else []
    return d


@app.get("/api/papers")
def list_papers():
    return [_paper_dict(r) for r in db.list_papers()]


@app.post("/api/papers")
def upload_papers(files: list[UploadFile] = File(...)):
    existing = {p["filename"] for p in db.list_papers()}
    created, skipped_duplicate, failed = [], [], []
    for f in files:
        if f.filename in existing:
            skipped_duplicate.append(f.filename)
            continue
        if not f.filename.lower().endswith(".pdf"):
            failed.append({"filename": f.filename, "error": "Not a PDF file"})
            continue

        paper_id = db.new_id()
        try:
            dest_dir = config.PAPERS_DIR / paper_id
            dest_dir.mkdir(parents=True, exist_ok=True)
            dest = dest_dir / f.filename
            dest.write_bytes(f.file.read())

            title = f.filename.rsplit(".", 1)[0]
            text = pdf_parser.extract_text(str(dest), image_dir=db.image_dir_for(paper_id))
            if not text or not text.strip():
                raise ValueError("No extractable text (likely a scanned/image-only PDF)")
            db.add_paper(paper_id=paper_id, title=title, filename=f.filename, full_text=text)
        except Exception as e:  # noqa: BLE001 - one bad file must never abort the rest of the batch
            failed.append({"filename": f.filename, "error": str(e)})
            shutil.rmtree(config.PAPERS_DIR / paper_id, ignore_errors=True)
            continue

        _progress_queues[paper_id] = queue.Queue()
        _work_queue.put(paper_id)
        created.append({"id": paper_id, "title": title})
        db.log_activity("paper_uploaded", f'Uploaded "{title}"', paper_id)
    return {"created": created, "skipped_duplicate": skipped_duplicate, "failed": failed}


@app.get("/api/papers/{paper_id}/progress")
async def paper_progress(paper_id: str):
    import asyncio

    async def event_gen():
        q = _progress_queues.get(paper_id)
        if not q:
            paper = db.get_paper(paper_id)
            state = "processed" if paper and paper["status"] == "processed" else "unknown"
            yield f"data: __DONE__:{state}\n\n"
            return
        loop = asyncio.get_event_loop()
        while True:
            msg = await loop.run_in_executor(None, q.get)
            yield f"data: {msg}\n\n"
            if msg == "__DONE__" or msg.startswith("__ERROR__"):
                break

    return StreamingResponse(event_gen(), media_type="text/event-stream")


@app.get("/api/papers/{paper_id}")
def get_paper_detail(paper_id: str):
    paper = db.get_paper(paper_id)
    if not paper:
        raise HTTPException(404, "Paper not found")

    sections = [dict(s) for s in db.get_sections(paper_id)]
    equations = [dict(e) for e in db.get_equations(paper_id)]
    images = [dict(i) for i in db.get_images(paper_id)]
    for i in images:
        i["url"] = media_url(i["file_path"])
    tables = [dict(t) for t in db.get_tables(paper_id)]
    claims = [dict(c) for c in db.get_claims(paper_id)]
    first_principles = [dict(f) for f in db.get_first_principles(paper_id)]
    cards = [dict(c) for c in db.get_flashcards_for_paper(paper_id)]
    diagram = db.get_diagram(paper_id)
    glossary = [dict(g) for g in db.get_glossary(paper_id)]
    notes = [dict(n) for n in db.get_notes(paper_id)]
    tags = db.get_tags_for_paper(paper_id)
    mental_models = [dict(m) for m in db.get_mental_models_for_paper(paper_id)]
    progress = db.paper_read_progress(paper_id)

    pdf_path = config.PAPERS_DIR / paper_id / paper["filename"]

    return {
        "paper": dict(paper),
        "sections": sections,
        "equations": equations,
        "images": images,
        "tables": tables,
        "claims": claims,
        "first_principles": first_principles,
        "flashcards": cards,
        "diagram": dict(diagram) if diagram else None,
        "glossary": glossary,
        "notes": notes,
        "tags": tags,
        "mental_models": mental_models,
        "read_progress": progress,
        "pdf_url": media_url(str(pdf_path)) if pdf_path.exists() else None,
    }


@app.delete("/api/papers/{paper_id}")
def delete_paper(paper_id: str):
    db.delete_paper(paper_id)
    _progress_queues.pop(paper_id, None)
    return {"deleted": True}


class FavoritePayload(BaseModel):
    is_favorite: bool


@app.put("/api/papers/{paper_id}/favorite")
def set_paper_favorite(paper_id: str, payload: FavoritePayload):
    paper = db.get_paper(paper_id)
    if not paper:
        raise HTTPException(404, "Paper not found")
    db.set_paper_favorite(paper_id, payload.is_favorite)
    if payload.is_favorite:
        db.log_activity("paper_favorited", f'Starred "{paper["title"]}"', paper_id)
    return {"ok": True}


@app.get("/api/papers/{paper_id}/mindmap")
def get_mindmap(paper_id: str):
    paper = db.get_paper(paper_id)
    if not paper:
        raise HTTPException(404, "Paper not found")
    sections = db.get_sections(paper_id)
    equations = db.get_equations(paper_id)
    images = db.get_images(paper_id)
    tables = db.get_tables(paper_id)
    return pipeline.generate_mindmap_tree(paper["title"], sections, equations, images, tables)


class ReadPayload(BaseModel):
    is_read: bool


@app.post("/api/sections/{section_id}/read")
def mark_section_read(section_id: int, payload: ReadPayload):
    db.set_section_read(section_id, payload.is_read)
    return {"ok": True}


# ------------------------------------------------------------------- Notes
class NotePayload(BaseModel):
    section_name: str = ""
    content: str


@app.get("/api/papers/{paper_id}/notes")
def list_notes(paper_id: str):
    return [dict(n) for n in db.get_notes(paper_id)]


@app.post("/api/papers/{paper_id}/notes")
def create_note(paper_id: str, payload: NotePayload):
    note_id = db.add_note(paper_id, payload.section_name, payload.content)
    paper = db.get_paper(paper_id)
    db.log_activity("note_added", f'Added a note on "{paper["title"]}"' if paper else "Added a note", paper_id)
    return {"id": note_id}


@app.put("/api/notes/{note_id}")
def edit_note(note_id: int, payload: NotePayload):
    db.update_note(note_id, payload.content)
    return {"ok": True}


@app.delete("/api/notes/{note_id}")
def remove_note(note_id: int):
    db.delete_note(note_id)
    return {"ok": True}


# --------------------------------------------------------- Human written notes
class HumanNotesPayload(BaseModel):
    content: str


@app.get("/api/papers/{paper_id}/human-notes")
def get_human_notes(paper_id: str):
    return db.get_human_notes(paper_id)


@app.put("/api/papers/{paper_id}/human-notes")
def save_human_notes(paper_id: str, payload: HumanNotesPayload):
    db.save_human_notes(paper_id, payload.content)
    return {"ok": True}


# ------------------------------------------------------------------- Highlights
class HighlightPayload(BaseModel):
    page_number: int
    start_offset: int
    end_offset: int
    snippet: str = ""
    color: str = "yellow"


@app.get("/api/papers/{paper_id}/highlights")
def list_highlights(paper_id: str):
    return [dict(h) for h in db.get_highlights(paper_id)]


@app.post("/api/papers/{paper_id}/highlights")
def create_highlight(paper_id: str, payload: HighlightPayload):
    highlight_id = db.add_highlight(
        paper_id, payload.page_number, payload.start_offset, payload.end_offset, payload.snippet, payload.color
    )
    paper = db.get_paper(paper_id)
    db.log_activity("highlight_added", f'Highlighted text in "{paper["title"]}"' if paper else "Added a highlight", paper_id)
    return {"id": highlight_id}


@app.delete("/api/highlights/{highlight_id}")
def remove_highlight(highlight_id: int):
    db.delete_highlight(highlight_id)
    return {"ok": True}


# -------------------------------------------------------------------- Tags
class TagPayload(BaseModel):
    name: str


@app.get("/api/tags")
def list_tags():
    return [dict(t) for t in db.list_all_tags()]


@app.post("/api/papers/{paper_id}/tags")
def add_tag(paper_id: str, payload: TagPayload):
    db.add_tag_to_paper(paper_id, payload.name)
    paper = db.get_paper(paper_id)
    db.log_activity("tag_added", f'Tagged "{paper["title"]}" as {payload.name}' if paper else f"Added tag {payload.name}", paper_id)
    return {"ok": True}


@app.delete("/api/papers/{paper_id}/tags/{tag_name}")
def remove_tag(paper_id: str, tag_name: str):
    db.remove_tag_from_paper(paper_id, tag_name)
    return {"ok": True}


# ------------------------------------------------------------- Collections
class CollectionPayload(BaseModel):
    name: str


@app.get("/api/collections")
def list_collections():
    return [dict(c) for c in db.list_collections()]


@app.post("/api/collections")
def create_collection(payload: CollectionPayload):
    cid = db.create_collection(payload.name)
    return {"id": cid}


@app.delete("/api/collections/{collection_id}")
def delete_collection(collection_id: int):
    db.delete_collection(collection_id)
    return {"ok": True}


@app.get("/api/collections/{collection_id}/papers")
def collection_papers(collection_id: int):
    return [dict(p) for p in db.get_papers_in_collection(collection_id)]


@app.post("/api/collections/{collection_id}/papers/{paper_id}")
def add_to_collection(collection_id: int, paper_id: str):
    db.add_paper_to_collection(paper_id, collection_id)
    return {"ok": True}


@app.delete("/api/collections/{collection_id}/papers/{paper_id}")
def remove_from_collection(collection_id: int, paper_id: str):
    db.remove_paper_from_collection(paper_id, collection_id)
    return {"ok": True}


# --------------------------------------------------------------- Glossary
@app.get("/api/glossary/search")
def glossary_search(q: str):
    return [dict(g) for g in db.search_glossary(q)]


@app.get("/api/concepts")
def concepts():
    return db.list_concepts()


# ---------------------------------------------------------- Mental models
@app.get("/api/mental-models")
def list_mental_models():
    return [dict(m) for m in db.list_mental_models()]


@app.get("/api/mental-models/{model_id}/papers")
def mental_model_papers(model_id: int):
    return [dict(p) for p in db.get_papers_for_mental_model(model_id)]


@app.get("/api/papers/{paper_id}/mental-models")
def paper_mental_models(paper_id: str):
    return [dict(m) for m in db.get_mental_models_for_paper(paper_id)]


class MentalModelPayload(BaseModel):
    name: str
    note: str = ""


@app.post("/api/papers/{paper_id}/mental-models")
def add_mental_model(paper_id: str, payload: MentalModelPayload):
    model_id = db.add_mental_model_to_paper(paper_id, payload.name, payload.note)
    paper = db.get_paper(paper_id)
    db.log_activity("mental_model_tagged", f'Tagged "{paper["title"]}" with {payload.name}' if paper else f"Tagged with {payload.name}", paper_id)
    return {"id": model_id}


@app.delete("/api/papers/{paper_id}/mental-models/{model_id}")
def remove_mental_model(paper_id: str, model_id: int):
    db.remove_mental_model_from_paper(paper_id, model_id)
    return {"ok": True}


@app.post("/api/papers/{paper_id}/mental-models/suggest")
def suggest_mental_models(paper_id: str):
    paper = db.get_paper(paper_id)
    if not paper:
        raise HTTPException(404, "Paper not found")
    canonical = [m["name"] for m in db.list_mental_models()]
    return pipeline.suggest_mental_models(paper["full_text"], canonical)


# ------------------------------------------------------------------ Compare
class ComparePayload(BaseModel):
    paper_ids: list[str]


@app.post("/api/compare")
def compare(payload: ComparePayload):
    return pipeline.compare_papers(payload.paper_ids)


# ------------------------------------------------------------------ Search
@app.get("/api/search")
def search(q: str):
    keyword = db.keyword_search(q)
    semantic_hits = vectorstore.search(q, top_k=8)
    semantic = [
        {"paper_id": row["paper_id"], "paper_title": row["paper_title"], "chunk": row["chunk_text"], "score": score}
        for score, row in semantic_hits
    ]
    return {"keyword": keyword, "semantic": semantic}


# ---------------------------------------------------------------- Dashboard
@app.get("/api/dashboard")
def dashboard():
    return db.dashboard_stats()


# --------------------------------------------------------------- Flashcards
@app.get("/api/flashcards/due")
def due_flashcards(limit: int = 20):
    return [dict(c) for c in db.get_due_flashcards(limit)]


class ReviewPayload(BaseModel):
    rating: int  # 1=Again 2=Hard 3=Good 4=Easy


@app.post("/api/flashcards/{card_id}/review")
def review_flashcard(card_id: int, payload: ReviewPayload):
    with db.get_conn() as conn:
        row = conn.execute("SELECT * FROM flashcards WHERE id = ?", (card_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Flashcard not found")
    scheduler.review_flashcard(row, Rating(payload.rating))
    return {"ok": True}


# ------------------------------------------------------------- Synthesize
class SynthesizePayload(BaseModel):
    question: str
    paper_ids: Optional[list[str]] = None
    mode: str = "answer"


@app.post("/api/synthesize")
def synthesize(payload: SynthesizePayload):
    answer = pipeline.synthesize(payload.question, payload.paper_ids, mode=payload.mode)
    return {"answer": answer, "backend": llm.last_backend_used()}


class AskPayload(BaseModel):
    question: str
    history: Optional[list[dict]] = None


@app.get("/api/papers/{paper_id}/chat")
def get_chat_history(paper_id: str):
    return [dict(m) for m in db.get_chat_messages(paper_id)]


@app.post("/api/papers/{paper_id}/ask")
def ask_paper(paper_id: str, payload: AskPayload):
    answer = pipeline.ask_paper(paper_id, payload.question, payload.history)
    db.add_chat_message(paper_id, "user", payload.question)
    db.add_chat_message(paper_id, "assistant", answer)
    return {"answer": answer, "backend": llm.last_backend_used()}


# ----------------------------------------------------------------- Audio
class AudioPayload(BaseModel):
    text: str
    voice: str = audio.DEFAULT_VOICE


@app.post("/api/audio")
def synthesize_audio(payload: AudioPayload):
    path = audio.synthesize(payload.text, payload.voice)
    return FileResponse(path, media_type="audio/mpeg")


@app.get("/api/voices")
def list_voices():
    return list(audio.VOICES.keys())


@app.get("/api/papers/{paper_id}/audio/full")
def synthesize_full_audio(paper_id: str, voice: str = audio.DEFAULT_VOICE):
    paper = db.get_paper(paper_id)
    if not paper:
        raise HTTPException(404, "Paper not found")
    script, markers = pipeline.build_full_audio_script(paper_id)
    if not script.strip():
        raise HTTPException(400, "Nothing to narrate yet -- process this paper first")
    result = audio.synthesize_full_script(script, markers, voice)
    audio_path = Path(result["path"])
    return {
        "audio_url": f"/media/audio/{audio_path.name}",
        "markers": result["markers"],
    }


# ---------------------------------------------------------------- Exports
@app.get("/api/papers/{paper_id}/export/bibtex")
def export_bibtex(paper_id: str):
    return PlainTextResponse(export.paper_to_bibtex(paper_id))


@app.get("/api/papers/{paper_id}/export/markdown")
def export_markdown(paper_id: str):
    md = export.paper_to_markdown(paper_id)
    paper = db.get_paper(paper_id)
    filename = f"{paper['title'][:60].replace('/', '-')}.md"
    return Response(
        md, media_type="text/markdown",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/api/export/anki")
def export_anki(paper_ids: Optional[str] = None):
    ids = paper_ids.split(",") if paper_ids else None
    tsv = export.flashcards_to_anki_tsv(ids)
    return Response(
        tsv, media_type="text/tab-separated-values",
        headers={"Content-Disposition": 'attachment; filename="flashcards.tsv"'},
    )


# ------------------------------------------------------------------ Deep Research
class ResearchSessionPayload(BaseModel):
    paper_ids: list[str]
    title: str = ""


@app.post("/api/research/sessions")
def create_research_session(payload: ResearchSessionPayload):
    title = payload.title.strip()
    if not title:
        titles = [p["title"] for pid in payload.paper_ids if (p := db.get_paper(pid))]
        title = ", ".join(titles[:2]) + (f" +{len(titles) - 2} more" if len(titles) > 2 else "") if titles else "Untitled session"
    session_id = db.create_research_session(payload.paper_ids, title)
    db.log_activity("research_session_created", f'Started a Deep Research session: "{title}"')
    return {"id": session_id, "title": title}


@app.get("/api/research/sessions")
def list_research_sessions_endpoint():
    return db.list_research_sessions()


@app.get("/api/research/sessions/{session_id}")
def get_research_session_endpoint(session_id: str):
    session = db.get_research_session(session_id)
    if not session:
        raise HTTPException(404, "Session not found")
    return {"session": session, "messages": db.get_research_messages(session_id)}


@app.delete("/api/research/sessions/{session_id}")
def delete_research_session_endpoint(session_id: str):
    db.delete_research_session(session_id)
    return {"ok": True}


@app.get("/api/research/sessions/{session_id}/ask")
async def ask_research(session_id: str, question: str):
    import asyncio

    session = db.get_research_session(session_id)
    if not session:
        raise HTTPException(404, "Session not found")
    history = [{"role": m["role"], "content": m["content"]} for m in db.get_research_messages(session_id)]
    db.add_research_message(session_id, "user", question)

    async def event_gen():
        loop = asyncio.get_event_loop()
        gen = research.run_agent(session["paper_ids"], question, history)
        final = None
        while True:
            event = await loop.run_in_executor(None, lambda: next(gen, None))
            if event is None:
                break
            yield f"data: {json.dumps(event)}\n\n"
            if event["type"] == "answer":
                final = event
        if final:
            db.add_research_message(session_id, "assistant", final["text"], final["sources"], final["steps"])
        yield "data: __DONE__\n\n"

    return StreamingResponse(event_gen(), media_type="text/event-stream")


# --------------------------------------------------------------- Activity
@app.get("/api/activity")
def get_activity(limit: int = 50):
    return [dict(a) for a in db.get_recent_activity(limit)]


# --------------------------------------------------------------- Settings
# Read by the desktop Settings screen (and the plain-web equivalent). Changes
# are written to .env for the *next* launch -- the running process already
# read these into core/config.py and core/llm.py's default Ollama client at
# import time, so hot-swapping a live DB connection or model client mid
# request isn't attempted. The UI is explicit that a restart is needed.
ENV_PATH = config.ENV_PATH


@app.get("/api/settings")
def get_settings():
    return {
        "primary_llm": config.PRIMARY_LLM,
        "ollama_host": os.environ.get("OLLAMA_HOST", config.OLLAMA_HOST),
        "ollama_model": config.OLLAMA_MODEL,
        "data_dir": str(config.DATA_DIR),
        "gemini_model": config.GEMINI_MODEL,
        "has_gemini_key": bool(config.GEMINI_API_KEY),
    }


class SettingsPayload(BaseModel):
    primary_llm: Optional[str] = None
    ollama_host: Optional[str] = None
    ollama_model: Optional[str] = None
    data_dir: Optional[str] = None
    gemini_api_key: Optional[str] = None


def _write_env_overrides(updates: dict):
    lines = ENV_PATH.read_text().splitlines() if ENV_PATH.exists() else []
    keys_seen = set()
    new_lines = []
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            new_lines.append(line)
            continue
        key = stripped.split("=", 1)[0].strip()
        if key in updates:
            new_lines.append(f"{key}={updates[key]}")
            keys_seen.add(key)
        else:
            new_lines.append(line)
    for key, value in updates.items():
        if key not in keys_seen:
            new_lines.append(f"{key}={value}")
    ENV_PATH.write_text("\n".join(new_lines) + "\n")


@app.put("/api/settings")
def save_settings(payload: SettingsPayload):
    updates = {}
    if payload.primary_llm:
        updates["PRIMARY_LLM"] = payload.primary_llm
    if payload.ollama_host:
        updates["OLLAMA_HOST"] = payload.ollama_host
    if payload.ollama_model:
        updates["OLLAMA_MODEL"] = payload.ollama_model
    if payload.data_dir:
        updates["OCE_DATA_DIR"] = payload.data_dir
    if payload.gemini_api_key:
        updates["GEMINI_API_KEY"] = payload.gemini_api_key
    if updates:
        _write_env_overrides(updates)
    return {"ok": True, "restart_required": bool(updates)}


# ------------------------------------------------------------------- Misc
@app.get("/api/status")
def status():
    return {"primary_llm": config.PRIMARY_LLM, "last_backend": llm.last_backend_used()}


@app.get("/api/ollama/models")
def list_ollama_models():
    return llm.list_ollama_models()


@app.get("/api/anatomy")
def get_anatomy():
    return {"sections": anatomy.SECTIONS, "icons": anatomy.SECTION_ICONS}
