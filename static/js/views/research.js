import { api } from "../api.js";
import { el, escapeHtml, toast } from "../ui.js";

export async function renderResearch() {
  const root = document.getElementById("view-root");
  root.innerHTML = `<div class="muted">Loading...</div>`;

  const [allPapers, sessions] = await Promise.all([
    api.listPapers(),
    api.listResearchSessions(),
  ]);
  const papers = allPapers.filter((p) => p.status === "processed");

  root.innerHTML = `
    <div class="page-title">🔭 Deep Research Chat</div>
    <p class="muted mt-1">Pick one or more papers, ask a question, and an agent will search and read
    the live web (free, no API keys) to verify, extend, or update what the paper(s) say -- every answer
    grounds itself in real research with direct links to its original sources, plus a visible reasoning
    trace, not just a black-box answer. Each turn runs several real search/read/think steps, so it can
    take a few minutes -- the trace updates live as it works.</p>
    <div class="research-layout mt-2">
      <div class="research-rail">
        <div class="card">
          <div class="text-sm muted" style="margin-bottom:6px;">New session -- select paper(s)</div>
          <div id="paper-picker" class="research-paper-picker"></div>
          <button id="start-session-btn" class="primary sm w-full mt-1" ${papers.length ? "" : "disabled"}>+ New Research Session</button>
        </div>
        <div class="text-sm muted mt-2" style="margin-bottom:6px;">Past sessions</div>
        <div id="session-list" class="research-session-list"></div>
      </div>
      <div class="research-main card" id="research-main">
        <div class="empty-state"><div class="icon">🔭</div><p>Select papers and start a session, or open one from the left.</p></div>
      </div>
    </div>
  `;

  if (!papers.length) {
    root.querySelector(".research-main").innerHTML =
      `<div class="empty-state"><div class="icon">📄</div><p>Process at least one paper first.</p></div>`;
  }

  const pickerBox = root.querySelector("#paper-picker");
  for (const p of papers) {
    const row = el(`
      <label class="research-paper-row">
        <input type="checkbox" value="${p.id}">
        <span>${escapeHtml(p.title)}</span>
      </label>`);
    pickerBox.appendChild(row);
  }

  const sessionListBox = root.querySelector("#session-list");
  function drawSessions() {
    sessionListBox.innerHTML = sessions.length ? "" : `<p class="faint">No sessions yet.</p>`;
    for (const s of sessions) {
      const item = el(`
        <div class="research-session-item" data-id="${s.id}">
          <div class="research-session-title">${escapeHtml(s.title || "Untitled session")}</div>
          <div class="faint">${s.paper_ids.length} paper${s.paper_ids.length === 1 ? "" : "s"} · ${new Date(s.created_at).toLocaleDateString()}</div>
        </div>`);
      item.onclick = () => openSession(s.id);
      sessionListBox.appendChild(item);
    }
  }
  drawSessions();

  root.querySelector("#start-session-btn").onclick = async () => {
    const selected = Array.from(pickerBox.querySelectorAll("input:checked")).map((i) => i.value);
    if (!selected.length) { toast("Select at least one paper first.", "error"); return; }
    const { id } = await api.createResearchSession(selected);
    sessions.unshift(await api.getResearchSession(id).then((r) => ({ ...r.session, paper_ids: r.session.paper_ids })));
    drawSessions();
    openSession(id);
  };

  async function openSession(sessionId) {
    const mainBox = root.querySelector("#research-main");
    mainBox.innerHTML = `<div class="muted">Loading session...</div>`;
    const { session, messages } = await api.getResearchSession(sessionId);
    const paperTitles = session.paper_ids
      .map((pid) => papers.find((p) => p.id === pid)?.title || allPapers.find((p) => p.id === pid)?.title || pid);

    mainBox.innerHTML = `
      <div class="research-session-head">
        <strong>${escapeHtml(session.title || "Untitled session")}</strong>
        <div class="faint mt-1">Grounded in: ${paperTitles.map(escapeHtml).join(", ")}</div>
      </div>
      <div class="chat-log" id="research-log"></div>
      <div class="chat-input-row">
        <textarea id="research-input" placeholder="Ask a question -- the agent may search and read the web to answer it..."></textarea>
        <button id="research-send" class="primary">Send</button>
      </div>
    `;
    const log = mainBox.querySelector("#research-log");
    for (const m of messages) {
      if (m.role === "user") appendUserBubble(log, m.content);
      else appendAssistantBubble(log, m.content, m.sources, m.steps);
    }
    log.scrollTop = log.scrollHeight;

    const input = mainBox.querySelector("#research-input");
    async function send() {
      const q = input.value.trim();
      if (!q) return;
      input.value = "";
      appendUserBubble(log, q);
      const { bubble, traceBox, setAnswer } = appendLiveAssistantBubble(log);
      log.scrollTop = log.scrollHeight;

      const steps = [];
      const es = new EventSource(api.researchAskStreamUrl(sessionId, q));
      es.onmessage = (e) => {
        if (e.data === "__DONE__") { es.close(); return; }
        let event;
        try { event = JSON.parse(e.data); } catch { return; }
        if (event.type === "answer") {
          setAnswer(event.text, event.sources, steps);
        } else {
          steps.push(event);
          traceBox.appendChild(renderStep(event));
          log.scrollTop = log.scrollHeight;
        }
      };
      es.onerror = () => {
        es.close();
        bubble.querySelector(".research-answer-text").innerHTML = `<span style="color:var(--red);">Connection lost -- try again.</span>`;
      };
    }
    mainBox.querySelector("#research-send").onclick = send;
    input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } });
    input.focus();
  }

  function appendUserBubble(log, text) {
    log.appendChild(el(`<div class="chat-msg user">${escapeHtml(text)}</div>`));
  }

  function renderStep(step) {
    if (step.type === "thought") {
      return el(`<div class="trace-step trace-thought">🤔 ${escapeHtml(step.text)}</div>`);
    }
    if (step.type === "search") {
      const results = (step.results || [])
        .map((r) => `<li><a href="${escapeHtml(r.href)}" target="_blank" rel="noopener">${escapeHtml(r.title || r.href)}</a></li>`)
        .join("");
      return el(`<div class="trace-step trace-search">🔎 Searched "<strong>${escapeHtml(step.query)}</strong>"<ul class="trace-results">${results}</ul></div>`);
    }
    if (step.type === "fetch") {
      return el(`<div class="trace-step trace-fetch">🌐 Read <a href="${escapeHtml(step.url)}" target="_blank" rel="noopener">${escapeHtml(step.url)}</a>
        <div class="faint mt-1">${escapeHtml((step.excerpt || "").slice(0, 180))}${(step.excerpt || "").length > 180 ? "…" : ""}</div></div>`);
    }
    return el(`<div class="trace-step">${escapeHtml(JSON.stringify(step))}</div>`);
  }

  function appendLiveAssistantBubble(log) {
    const bubble = el(`
      <div class="chat-msg assistant research-bubble">
        <details class="research-trace" open>
          <summary>🔍 Research trace <span class="spinner"></span></summary>
          <div class="trace-steps"></div>
        </details>
        <div class="research-answer-text"><span class="spinner"></span> Working -- watch the trace above for live progress (this can take a few minutes)...</div>
        <div class="research-sources"></div>
      </div>`);
    log.appendChild(bubble);
    const traceBox = bubble.querySelector(".trace-steps");
    function setAnswer(text, sources, steps) {
      bubble.querySelector(".research-trace summary").innerHTML = `🔍 Research trace (${steps.length} step${steps.length === 1 ? "" : "s"})`;
      bubble.querySelector(".research-trace").open = false;
      bubble.querySelector(".research-answer-text").innerHTML = escapeHtml(text || "").replace(/\n/g, "<br>");
      const sourcesBox = bubble.querySelector(".research-sources");
      if (sources && sources.length) {
        sourcesBox.innerHTML = `<div class="text-sm muted mt-1">Sources</div>` +
          sources.map((s, i) => `<div class="source-chip">[${i + 1}] <a href="${escapeHtml(s.url)}" target="_blank" rel="noopener">${escapeHtml(s.title || s.url)}</a></div>`).join("");
      }
    }
    return { bubble, traceBox, setAnswer };
  }

  function appendAssistantBubble(log, text, sources, steps) {
    const bubble = el(`
      <div class="chat-msg assistant research-bubble">
        ${steps && steps.length ? `<details class="research-trace">
          <summary>🔍 Research trace (${steps.length} step${steps.length === 1 ? "" : "s"})</summary>
          <div class="trace-steps"></div>
        </details>` : ""}
        <div class="research-answer-text">${escapeHtml(text || "").replace(/\n/g, "<br>")}</div>
        <div class="research-sources">${sources && sources.length ? `<div class="text-sm muted mt-1">Sources</div>` +
          sources.map((s, i) => `<div class="source-chip">[${i + 1}] <a href="${escapeHtml(s.url)}" target="_blank" rel="noopener">${escapeHtml(s.title || s.url)}</a></div>`).join("") : ""}</div>
      </div>`);
    log.appendChild(bubble);
    const traceBox = bubble.querySelector(".trace-steps");
    if (traceBox && steps) {
      for (const step of steps) traceBox.appendChild(renderStep(step));
    }
  }
}
