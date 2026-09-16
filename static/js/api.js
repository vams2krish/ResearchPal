const BASE = "";

async function request(method, path, { json, form } = {}) {
  const opts = { method, headers: {} };
  if (json !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(json);
  } else if (form !== undefined) {
    opts.body = form; // FormData -- browser sets multipart headers
  }
  const res = await fetch(BASE + path, opts);
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail || detail; } catch { /* not json */ }
    throw new Error(detail);
  }
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return res.json();
  return res;
}

export const api = {
  // Papers
  listPapers: () => request("GET", "/api/papers"),
  uploadPapers: (files) => {
    const form = new FormData();
    for (const f of files) form.append("files", f);
    return request("POST", "/api/papers", { form });
  },
  getPaper: (id) => request("GET", `/api/papers/${id}`),
  deletePaper: (id) => request("DELETE", `/api/papers/${id}`),
  setFavorite: (id, isFavorite) => request("PUT", `/api/papers/${id}/favorite`, { json: { is_favorite: isFavorite } }),
  progressStreamUrl: (id) => `/api/papers/${id}/progress`,
  getMindmap: (id) => request("GET", `/api/papers/${id}/mindmap`),
  markSectionRead: (sectionId, isRead) =>
    request("POST", `/api/sections/${sectionId}/read`, { json: { is_read: isRead } }),

  // Notes
  listNotes: (paperId) => request("GET", `/api/papers/${paperId}/notes`),
  createNote: (paperId, sectionName, content) =>
    request("POST", `/api/papers/${paperId}/notes`, { json: { section_name: sectionName, content } }),
  updateNote: (noteId, content) => request("PUT", `/api/notes/${noteId}`, { json: { content } }),
  deleteNote: (noteId) => request("DELETE", `/api/notes/${noteId}`),

  // Tags
  listTags: () => request("GET", "/api/tags"),
  addTag: (paperId, name) => request("POST", `/api/papers/${paperId}/tags`, { json: { name } }),
  removeTag: (paperId, name) => request("DELETE", `/api/papers/${paperId}/tags/${encodeURIComponent(name)}`),

  // Collections
  listCollections: () => request("GET", "/api/collections"),
  createCollection: (name) => request("POST", "/api/collections", { json: { name } }),
  deleteCollection: (id) => request("DELETE", `/api/collections/${id}`),
  collectionPapers: (id) => request("GET", `/api/collections/${id}/papers`),
  addToCollection: (collectionId, paperId) => request("POST", `/api/collections/${collectionId}/papers/${paperId}`),
  removeFromCollection: (collectionId, paperId) => request("DELETE", `/api/collections/${collectionId}/papers/${paperId}`),

  // Glossary
  searchGlossary: (q) => request("GET", `/api/glossary/search?q=${encodeURIComponent(q)}`),

  // Concepts (cross-library glossary index)
  listConcepts: () => request("GET", "/api/concepts"),

  // Mental models
  listMentalModels: () => request("GET", "/api/mental-models"),
  papersForMentalModel: (id) => request("GET", `/api/mental-models/${id}/papers`),
  mentalModelsForPaper: (paperId) => request("GET", `/api/papers/${paperId}/mental-models`),
  addMentalModel: (paperId, name, note = "") =>
    request("POST", `/api/papers/${paperId}/mental-models`, { json: { name, note } }),
  removeMentalModel: (paperId, modelId) =>
    request("DELETE", `/api/papers/${paperId}/mental-models/${modelId}`),
  suggestMentalModels: (paperId) =>
    request("POST", `/api/papers/${paperId}/mental-models/suggest`),

  // Compare
  comparePapers: (paperIds) => request("POST", "/api/compare", { json: { paper_ids: paperIds } }),

  // Search
  search: (q) => request("GET", `/api/search?q=${encodeURIComponent(q)}`),

  // Dashboard
  dashboard: () => request("GET", "/api/dashboard"),

  // Flashcards
  dueFlashcards: (limit = 20) => request("GET", `/api/flashcards/due?limit=${limit}`),
  reviewFlashcard: (id, rating) => request("POST", `/api/flashcards/${id}/review`, { json: { rating } }),

  // Synthesize / Ask
  synthesize: (question, paperIds, mode) =>
    request("POST", "/api/synthesize", { json: { question, paper_ids: paperIds, mode } }),
  askPaper: (paperId, question, history) =>
    request("POST", `/api/papers/${paperId}/ask`, { json: { question, history } }),
  getChatHistory: (paperId) => request("GET", `/api/papers/${paperId}/chat`),

  // Audio
  listVoices: () => request("GET", "/api/voices"),
  audioUrlFor: () => "/api/audio",
  getFullAudio: (paperId, voice) => request("GET", `/api/papers/${paperId}/audio/full?voice=${encodeURIComponent(voice)}`),

  // Human written notes
  getHumanNotes: (paperId) => request("GET", `/api/papers/${paperId}/human-notes`),
  saveHumanNotes: (paperId, content) => request("PUT", `/api/papers/${paperId}/human-notes`, { json: { content } }),

  // PDF highlights
  listHighlights: (paperId) => request("GET", `/api/papers/${paperId}/highlights`),
  createHighlight: (paperId, highlight) => request("POST", `/api/papers/${paperId}/highlights`, { json: highlight }),
  deleteHighlight: (highlightId) => request("DELETE", `/api/highlights/${highlightId}`),

  // Deep Research
  createResearchSession: (paperIds, title = "") =>
    request("POST", "/api/research/sessions", { json: { paper_ids: paperIds, title } }),
  listResearchSessions: () => request("GET", "/api/research/sessions"),
  getResearchSession: (id) => request("GET", `/api/research/sessions/${id}`),
  deleteResearchSession: (id) => request("DELETE", `/api/research/sessions/${id}`),
  researchAskStreamUrl: (sessionId, question) =>
    `/api/research/sessions/${sessionId}/ask?question=${encodeURIComponent(question)}`,

  // Exports
  exportBibtexUrl: (paperId) => `/api/papers/${paperId}/export/bibtex`,
  exportMarkdownUrl: (paperId) => `/api/papers/${paperId}/export/markdown`,
  exportAnkiUrl: (paperIds) => `/api/export/anki${paperIds ? "?paper_ids=" + paperIds.join(",") : ""}`,

  // Misc
  status: () => request("GET", "/api/status"),
  anatomy: () => request("GET", "/api/anatomy"),
  getActivity: (limit = 50) => request("GET", `/api/activity?limit=${limit}`),
  listOllamaModels: () => request("GET", "/api/ollama/models"),
  getSettings: () => request("GET", "/api/settings"),
  saveSettings: (settings) => request("PUT", "/api/settings", { json: settings }),
};
