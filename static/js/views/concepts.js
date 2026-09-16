import { api } from "../api.js";
import { el, escapeHtml } from "../ui.js";
import { navigate } from "../router.js";

export async function renderConcepts() {
  const root = document.getElementById("view-root");
  root.innerHTML = `
    <div class="page-title">🔗 Concept index</div>
    <p class="muted">Every glossary term across your whole library, grouped by concept. Terms
    shared by multiple papers -- and how each paper's definition compares -- float to the top.</p>
    <input id="concept-search" type="search" class="w-full mt-1" placeholder="Filter concepts...">
    <div id="concept-list" class="mt-2"></div>
  `;
  const list = root.querySelector("#concept-list");
  const input = root.querySelector("#concept-search");

  const concepts = await api.listConcepts();
  if (!concepts.length) {
    list.innerHTML = `<div class="empty-state"><p>No glossary terms yet -- process some papers first.</p></div>`;
    return;
  }

  function draw(filter) {
    const q = filter.trim().toLowerCase();
    const shown = q
      ? concepts.filter((c) => c.term.toLowerCase().includes(q) || c.papers.some((p) => p.definition.toLowerCase().includes(q)))
      : concepts;
    list.innerHTML = "";
    if (!shown.length) { list.innerHTML = `<p class="muted text-sm">No matching concepts.</p>`; return; }
    for (const c of shown) {
      const shared = c.papers.length > 1;
      const card = el(`
        <div class="card">
          <div class="flex justify-between items-center">
            <strong>${escapeHtml(c.term)}</strong>
            <span class="badge-pill ${shared ? "blue" : "gray"}">${c.papers.length} paper${c.papers.length !== 1 ? "s" : ""}</span>
          </div>
          <div class="mt-1" id="defs"></div>
        </div>`);
      const defs = card.querySelector("#defs");
      for (const p of c.papers) {
        const row = el(`
          <div class="mt-1" style="cursor:pointer;">
            <span class="faint">${escapeHtml(p.paper_title)}</span>
            <p class="text-sm">${escapeHtml(p.definition)}</p>
          </div>`);
        row.onclick = () => navigate(`/paper/${p.paper_id}`);
        defs.appendChild(row);
      }
      list.appendChild(card);
    }
  }
  draw("");
  let t;
  input.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => draw(input.value), 200); });
}
