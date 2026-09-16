import { api } from "../api.js";
import { el, escapeHtml } from "../ui.js";
import { navigate } from "../router.js";

const MAX_COMPARE = 4;

export async function renderCompare() {
  const root = document.getElementById("view-root");
  const papers = (await api.listPapers()).filter((p) => p.status === "processed");

  root.innerHTML = `
    <div class="page-title">🆚 Compare papers</div>
    <p class="muted">Pick 2-${MAX_COMPARE} processed papers to see them side by side: method, dataset,
    metrics, results, novelty, and limitations -- structured, not just prose.</p>
    ${papers.length < 2 ? `<div class="empty-state"><p>Need at least 2 processed papers to compare.</p></div>` : `
    <div class="card">
      <label class="text-sm muted">Select 2-${MAX_COMPARE} papers</label>
      <select id="paper-select" multiple size="6" class="w-full mt-1">
        ${papers.map((p) => `<option value="${p.id}">${escapeHtml(p.title)}</option>`).join("")}
      </select>
      <button id="run-btn" class="primary mt-2">Compare</button>
    </div>
    <div id="compare-result" class="mt-2"></div>
    `}
  `;
  if (papers.length < 2) return;

  const result = root.querySelector("#compare-result");
  root.querySelector("#run-btn").onclick = async () => {
    const selected = Array.from(root.querySelector("#paper-select").selectedOptions).map((o) => o.value);
    if (selected.length < 2) { result.innerHTML = `<p class="muted text-sm">Select at least 2 papers.</p>`; return; }
    if (selected.length > MAX_COMPARE) { result.innerHTML = `<p class="muted text-sm">Select at most ${MAX_COMPARE} papers.</p>`; return; }
    result.innerHTML = `<div class="flex items-center gap-2 mt-2"><span class="spinner"></span> Comparing...</div>`;
    try {
      const { papers: comparedPapers, rows } = await api.comparePapers(selected);
      renderTable(comparedPapers, rows);
    } catch (err) {
      result.innerHTML = `<span style="color:var(--red);">${err.message}</span>`;
    }
  };

  function renderTable(comparedPapers, rows) {
    const thead = `<tr><th>Aspect</th>${comparedPapers.map((p) => `<th>${escapeHtml(p.title)}</th>`).join("")}</tr>`;
    const tbody = rows.map((r) => `
      <tr>
        <td><strong>${escapeHtml(r.aspect)}</strong></td>
        ${comparedPapers.map((p) => `<td>${escapeHtml(r.values[p.id] || "—")}</td>`).join("")}
      </tr>`).join("");
    result.innerHTML = `<div style="overflow-x:auto;"><table class="paper-table">${`<thead>${thead}</thead>`}<tbody>${tbody}</tbody></table></div>`;
    const links = el(`<div class="flex gap-1 mt-2" style="flex-wrap:wrap;"></div>`);
    for (const p of comparedPapers) {
      const btn = el(`<button class="sm ghost-btn">Open "${escapeHtml(p.title.slice(0, 40))}${p.title.length > 40 ? "…" : ""}"</button>`);
      btn.onclick = () => navigate(`/paper/${p.id}`);
      links.appendChild(btn);
    }
    result.appendChild(links);
  }
}
