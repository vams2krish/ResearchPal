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
    paragraphs = [p.strip() for p in text.split("\n\n") if p.strip()]
    chunks = []
    current = ""
    for p in paragraphs:
        if len(current) + len(p) + 2 <= size:
            current = f"{current}\n\n{p}" if current else p
        else:
            if current:
                chunks.append(current)
            current = current[-overlap:] + "\n\n" + p if current else p
    if current:
        chunks.append(current)
    return chunks or [text[:size]]


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
        score = float(np.dot(query_norm, vec_norm))
        scored.append((score, row))

    scored.sort(key=lambda x: x[0], reverse=True)
    return scored[:top_k]
