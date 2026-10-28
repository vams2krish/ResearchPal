"""Persistent job manifests with bounded concurrency and visible failures."""
import json
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from core import config, providers

POOL = ThreadPoolExecutor(max_workers=2, thread_name_prefix="media")
LOCK = threading.RLock()
ACTIVE = set()


def folder():
    path = config.DATA_DIR / "jobs"
    path.mkdir(parents=True, exist_ok=True)
    return path


def read(job_id):
    if not job_id.isalnum():
        raise ValueError("Invalid job ID")
    with LOCK:
        data = json.loads((folder() / (job_id + ".json")).read_text(encoding="utf-8"))
        if data["status"] in ("queued", "running") and job_id not in ACTIVE:
            data.update(status="interrupted", message="App restarted. Start a new job; no paid request is automatically resubmitted.")
        return data


def update(job_id, **values):
    with LOCK:
        path = folder() / (job_id + ".json")
        data = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {"id": job_id}
        data.update(values)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        tmp.replace(path)


def submit(kind, paper_id, task):
    job_id = uuid.uuid4().hex
    snapshot = providers.load()
    with LOCK:
        ACTIVE.add(job_id)
        update(job_id, kind=kind, paper_id=paper_id, status="queued", progress=0,
               created_at=datetime.now(timezone.utc).isoformat(), message="Waiting to start")
    def run():
        token = providers.SNAPSHOT.set(snapshot)
        try:
            update(job_id, status="running", message="Starting")
            result = task(job_id)
            update(job_id, status="completed", progress=100, message="Ready", result=result)
        except Exception as error:
            # Only our own sanitized ValueErrors are exposed, never raw credential-bearing HTTP errors.
            message = str(error) if isinstance(error, ValueError) else "Job failed. Check provider connection, model and available tools."
            update(job_id, status="failed", message=message)
        finally:
            providers.SNAPSHOT.reset(token)
            with LOCK:
                ACTIVE.discard(job_id)
    POOL.submit(run)
    return {"id": job_id, "status": "queued"}


def list_jobs(paper_id=None):
    items = [read(path.stem) for path in folder().glob("*.json")]
    return sorted([item for item in items if not paper_id or item["paper_id"] == paper_id], key=lambda item: item["created_at"], reverse=True)
