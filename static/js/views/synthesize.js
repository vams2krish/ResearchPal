import { api } from "../api.js";
import { el, escapeHtml } from "../ui.js";

export async function renderSynthesize() {
  const root = document.getElementById("view-root");
  const papers = (await api.listPapers()).filter((p) => p.status === "processed");

  root.innerHTML = `
    <div class="page-title">🔀 Cross-paper synthesis</div>
    <p class="muted">Synthesize peer-reviewed literature across your library -- every answer grounds itself in
    your own uploaded papers, with direct links back to the original source material for anything cited.
    Compare papers, or make the model interrogate you instead of just answering.</p>
    ${!papers.length ? `<div class="empty-state"><p>No processed papers yet.</p></div>` : `
    <div class="card">
      <label class="text-sm muted">Limit to specific papers (leave empty to search your whole library)</label>
      <select id="paper-select" multiple size="4" class="w-full mt-1">
        ${papers.map((p) => `<option value="${p.id}">${escapeHtml(p.title)}</option>`).join("")}
      </select>
      <div class="flex gap-2 mt-2">
        <label class="flex items-center gap-1"><input type="radio" name="mode" value="answer" checked> 🧩 Answer</label>
        <label class="flex items-center gap-1"><input type="radio" name="mode" value="critique"> 🎯 Critique</label>
        <label class="flex items-center gap-1"><input type="radio" name="mode" value="systems"> 🧭 Systems thinker</label>
      </div>
      <div class="chat-input-row mt-2">
        <textarea id="question" placeholder="e.g. Where do these papers agree/disagree on X?"></textarea>
        <button id="run-btn" class="primary">Run</button>
      </div>
    </div>
    <div class="chat-log mt-2" id="chat-log"></div>
    `}
  `;
  if (!papers.length) return;

  const log = root.querySelector("#chat-log");
  async function run() {
    const question = root.querySelector("#question").value.trim();
    if (!question) return;
    const mode = root.querySelector('input[name="mode"]:checked').value;
    const selected = Array.from(root.querySelector("#paper-select").selectedOptions).map((o) => o.value);
    root.querySelector("#question").value = "";

    log.appendChild(el(`<div class="chat-msg user">${escapeHtml(question)}</div>`));
    const thinking = el(`<div class="chat-msg assistant"><span class="spinner"></span> Retrieving and synthesizing...</div>`);
    log.appendChild(thinking);
    thinking.scrollIntoView({ behavior: "smooth" });
    try {
      const { answer } = await api.synthesize(question, selected.length ? selected : null, mode);
      const candidates = selected.length ? papers.filter((p) => selected.includes(p.id)) : papers;
      thinking.innerHTML = linkifyPaperTitles(escapeHtml(answer).replace(/\n/g, "<br>"), candidates);
    } catch (err) {
      thinking.innerHTML = `<span style="color:var(--red);">${err.message}</span>`;
    }
  }
  root.querySelector("#run-btn").onclick = run;
}

/** Wraps any mention of a source paper's title in the (already-escaped) answer
 * HTML with a link to that paper's page -- makes "direct links to the
 * original source material" literally true instead of just a claim in the
 * synthesize prompt. Longest titles first so one title can't eat a substring
 * match that belongs to another, longer one. */
function linkifyPaperTitles(html, candidatePapers) {
  const sorted = [...candidatePapers].sort((a, b) => b.title.length - a.title.length);
  for (const p of sorted) {
    const escapedTitle = escapeHtml(p.title).trim();
    if (!escapedTitle) continue;
    const pattern = new RegExp(escapedTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
    html = html.replace(pattern, `<a href="#/paper/${p.id}" class="cited-paper-link">${escapedTitle}</a>`);
  }
  return html;
}
