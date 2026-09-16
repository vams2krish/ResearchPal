import { api } from "../api.js";
import { el, escapeHtml } from "../ui.js";
import { navigate } from "../router.js";

export async function renderModels() {
  const root = document.getElementById("view-root");
  root.innerHTML = `
    <div class="page-title">🧭 Mental models</div>
    <p class="muted">Frameworks of thinking your library's papers exemplify, rely on, or challenge --
    tag papers from their own page (Analysis Tools → Mental Models). Click a model to see which
    papers teach it.</p>
    <div id="models-list" class="grid mt-2"></div>
  `;
  const list = root.querySelector("#models-list");
  const models = await api.listMentalModels();
  const tagged = models.filter((m) => m.paper_count > 0);
  const untagged = models.filter((m) => m.paper_count === 0);

  if (!tagged.length) {
    list.innerHTML = `<div class="empty-state"><p>No papers tagged with a mental model yet. Open a processed paper and use the
      "🧭 Mental Models" tool tab to tag it, or let the model suggest some.</p></div>`;
  }

  for (const m of tagged) {
    const card = el(`
      <div class="card" style="cursor:pointer;">
        <div class="flex justify-between items-center">
          <strong>${escapeHtml(m.name)}</strong>
          <span class="badge-pill blue">${m.paper_count} paper${m.paper_count !== 1 ? "s" : ""}</span>
        </div>
        <p class="text-sm mt-1">${escapeHtml(m.description || "")}</p>
      </div>`);
    card.onclick = () => openModel(m);
    list.appendChild(card);
  }

  if (untagged.length) {
    root.appendChild(el(`<div class="page-title mt-3" style="font-size:15px;">Untagged models in the canonical list</div>`));
    const box = el(`<div class="flex gap-1 mt-1" style="flex-wrap:wrap;"></div>`);
    for (const m of untagged) box.appendChild(el(`<span class="tag-chip" title="${escapeHtml(m.description || "")}">${escapeHtml(m.name)}</span>`));
    root.appendChild(box);
  }

  async function openModel(m) {
    const papers = await api.papersForMentalModel(m.id);
    const box = el(`
      <div class="card mt-2">
        <strong>${escapeHtml(m.name)}</strong>
        <p class="text-sm mt-1">${escapeHtml(m.description || "")}</p>
        <div class="mt-1" id="model-papers"></div>
      </div>`);
    const papersBox = box.querySelector("#model-papers");
    for (const p of papers) {
      const row = el(`
        <div class="mt-1" style="cursor:pointer; border-top:1px solid var(--border); padding-top:8px;">
          <strong class="text-sm">${escapeHtml(p.title)}</strong>
          ${p.note ? `<p class="text-sm faint mt-1">${escapeHtml(p.note)}</p>` : ""}
        </div>`);
      row.onclick = () => navigate(`/paper/${p.id}`);
      papersBox.appendChild(row);
    }
    const existing = root.querySelector("#model-detail");
    if (existing) existing.remove();
    box.id = "model-detail";
    root.appendChild(box);
    box.scrollIntoView({ behavior: "smooth" });
  }
}
