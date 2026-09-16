import { api } from "../api.js";
import { escapeHtml } from "../ui.js";
import { navigate } from "../router.js";

export async function renderGlossary() {
  const root = document.getElementById("view-root");
  root.innerHTML = `
    <div class="page-title">📖 Glossary</div>
    <p class="muted">Every key term extracted across your whole library, in one searchable place.</p>
    <input id="glossary-search" type="search" class="w-full mt-1" placeholder="Search terms and definitions...">
    <div id="glossary-list" class="mt-2"></div>
  `;
  const list = root.querySelector("#glossary-list");
  const input = root.querySelector("#glossary-search");

  async function search(q) {
    if (!q.trim()) { list.innerHTML = `<p class="muted text-sm">Start typing to search terms across your library.</p>`; return; }
    const results = await api.searchGlossary(q);
    if (!results.length) { list.innerHTML = `<p class="muted text-sm">No matching terms.</p>`; return; }
    list.innerHTML = "";
    for (const g of results) {
      const card = document.createElement("div");
      card.className = "card";
      card.innerHTML = `<strong>${escapeHtml(g.term)}</strong> <span class="faint">— ${escapeHtml(g.paper_title)}</span>
        <p class="mt-1">${escapeHtml(g.definition)}</p>`;
      card.style.cursor = "pointer";
      card.onclick = () => navigate(`/paper/${g.paper_id}`);
      list.appendChild(card);
    }
  }
  let t;
  input.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => search(input.value), 250); });
  list.innerHTML = `<p class="muted text-sm">Start typing to search terms across your library.</p>`;
}
