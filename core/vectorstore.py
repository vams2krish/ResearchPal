"""Minimal local vector search: embeddings stored as BLOBs in SQLite,
similarity computed with plain numpy. No vector-DB server, no extra
dependencies -- fine up to tens of thousands of chunks, which covers a
personal library of hundreds/thousands of papers.
"""

import numpy as np

from core import db, llm

CHUNK_SIZE = 1200
CHUNK_OVERLAP = 200


def chunk_text(text: str, size: int = CHUNK_SIZE, overlap: int = CHUNK_OVERLAP) -> list[str]:
    if size <= 0 or overlap < 0 or overlap >= size:
        raise ValueError("Require size > 0 and 0 <= overlap < size")
    chunks = []
    start = 0
    while start < len(text):
        end = min(start + size, len(text))
        if end < len(text):
            boundary = max(text.rfind("\n\n", start + size // 2, end),
                           text.rfind(" ", start + size // 2, end))
            if boundary > start:
                end = boundary
        chunk = text[start:end]
        if chunk.strip():
            chunks.append(chunk)
        if end == len(text):
            break
        start = max(start + 1, end - overlap)
    return chunks


def index_paper(paper_id: str, full_text: str):
    chunks = chunk_text(full_text)
    embeddings = [llm.embed(c) for c in chunks]
    db.save_chunks(paper_id, chunks, embeddings)


def search(query: str, paper_ids: list[str] | None = None, top_k: int = 8):
    rows = db.get_all_chunks(paper_ids)
    if not rows:
        return []

    query_vec = np.array(llm.embed(query), dtype=np.float32)
    query_norm = query_vec / (np.linalg.norm(query_vec) + 1e-8)

    scored = []
    for row in rows:
        vec = np.frombuffer(row["embedding"], dtype=np.float32)
        vec_norm = vec / (np.linalg.norm(vec) + 1e-8)
        if len(vec) != len(query_vec):
            raise ValueError("Embedding model dimensions changed. Reindex your documents in Settings before searching.")
        score = float(np.dot(query_norm, vec_norm))
        scored.append((score, row))

    scored.sort(key=lambda x: x[0], reverse=True)
    return scored[:top_k]
