import { api } from "../api.js";
import { escapeHtml } from "../ui.js";
import { navigate } from "../router.js";

export async function renderSearch({ _query }) {
  const root = document.getElementById("view-root");
  const q = _query.q || "";
  root.innerHTML = `
    <div class="page-title">🔎 Search: "${escapeHtml(q)}"</div>
    <div id="results" class="mt-2"><div class="muted">Searching...</div></div>
  `;
  const box = root.querySelector("#results");
  if (!q.trim()) { box.innerHTML = `<p class="muted">Type something in the search box.</p>`; return; }

  const { keyword, semantic } = await api.search(q);
  box.innerHTML = "";

  if (keyword.papers.length) {
    box.appendChild(sectionTitle("📄 Matching papers"));
    for (const p of keyword.papers) box.appendChild(paperRow(p.paper_id, p.title, p.one_liner));
  }
  if (keyword.sections.length) {
    box.appendChild(sectionTitle("📑 Matching sections"));
    for (const s of keyword.sections) box.appendChild(paperRow(s.paper_id, `${s.title} — ${s.section_name}`, (s.explanation || "").slice(0, 160)));
  }
  if (semantic.length) {
    box.appendChild(sectionTitle("🧠 Semantically related passages"));
    for (const s of semantic) box.appendChild(paperRow(s.paper_id, s.paper_title, s.chunk.slice(0, 200)));
  }
  if (!keyword.papers.length && !keyword.sections.length && !semantic.length) {
    box.innerHTML = `<div class="empty-state"><p>No matches found.</p></div>`;
  }
}

function sectionTitle(t) {
  const h = document.createElement("h3");
  h.className = "mt-2";
  h.textContent = t;
  return h;
}

function paperRow(paperId, title, snippet) {
  const card = document.createElement("div");
  card.className = "card";
  card.style.cursor = "pointer";
  card.innerHTML = `<strong>${escapeHtml(title)}</strong><p class="text-sm muted mt-1">${escapeHtml(snippet || "")}</p>`;
  card.onclick = () => navigate(`/paper/${paperId}`);
  return card;
}
