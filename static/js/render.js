// Rendering helpers for math (KaTeX), diagrams (Mermaid), mind maps
// (markmap), the original PDF (pdf.js), and a hand-rolled pan/zoom image
// viewer. All libraries are loaded globally in index.html (no bundler).

export function renderLatex(container, latex) {
  try {
    window.katex.render(latex, container, { throwOnError: false, displayMode: true });
  } catch (e) {
    container.textContent = latex;
  }
}

/** Render $...$ / $$...$$ delimited inline math inside plain-language text. */
export function renderInlineMath(container) {
  if (window.renderMathInElement) {
    window.renderMathInElement(container, {
      delimiters: [
        { left: "$$", right: "$$", display: true },
        { left: "$", right: "$", display: false },
      ],
      throwOnError: false,
    });
  }
}

let mermaidInitialized = false;
export async function renderMermaid(container, code) {
  if (!mermaidInitialized) {
    window.mermaid.initialize({ startOnLoad: false, theme: document.documentElement.dataset.theme === "light" ? "default" : "dark" });
    mermaidInitialized = true;
  }
  try {
    const id = "mmd-" + Math.random().toString(36).slice(2);
    const { svg } = await window.mermaid.render(id, code);
    container.innerHTML = svg;
    const svgEl = container.querySelector("svg");
    const box = svgEl ? svgEl.getBBox() : null;
    if (!box || box.width < 30 || box.height < 30) {
      showDiagramFallback(container, code, "diagram layout came back empty");
    }
  } catch (err) {
    showDiagramFallback(container, code, err.message || String(err));
  }
}

function showDiagramFallback(container, code, reason) {
  container.innerHTML = `
    <p style="color:var(--orange); font-size:0.85rem;">Visual diagram unavailable (${reason}). Structure:</p>
    <pre class="code-block" style="white-space:pre-wrap;">${code.replace(/</g, "&lt;")}</pre>`;
}

export function renderMarkmap(container, tree) {
  container.innerHTML = `<svg style="display:block;"></svg>`;
  const svg = container.querySelector("svg");
  svg.setAttribute("width", container.clientWidth || 700);
  svg.setAttribute("height", 520);
  const { Markmap } = window.markmap;
  const mm = Markmap.create(svg, { color: () => "#818cf8", duration: 300 }, tree);
  setTimeout(() => {
    mm.fit();
    // Measure the whole rendered tree (svg.getBBox() aggregates every child),
    // not a single node's own box -- querying one "g.markmap-node" only
    // returns that one node's text bbox (~20px tall), which is always under
    // any reasonable threshold and made this fallback fire on every paper.
    const box = svg.getBBox();
    if (!box || box.width < 40 || box.height < 40) {
      showMindmapFallback(container, tree);
    }
  }, 400);
}

function buildFallbackList(node) {
  const hasChildren = node.children && node.children.length;
  if (!hasChildren) return `<li>${escapeHtml(node.content)}</li>`;
  const inner = node.children.map(buildFallbackList).join("");
  return `<li><details open><summary>${escapeHtml(node.content)}</summary><ul>${inner}</ul></details></li>`;
}

function showMindmapFallback(container, tree) {
  container.innerHTML =
    `<p style="color:var(--orange); font-size:0.85rem;">Interactive layout unavailable here -- plain expandable view:</p>` +
    `<ul style="font-size:0.9rem; line-height:1.7;">${buildFallbackList(tree)}</ul>`;
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s ?? "";
  return d.innerHTML;
}

window.pdfjsLib.GlobalWorkerOptions.workerSrc = "/assets/pdf.worker.min.js";

const PDF_BASE_SCALE = 1.4;

/** Original PDF viewer: zoom re-renders pages at a real pdf.js scale (crisp
 * text, not a CSS transform), and a real selectable text layer (pdf.js's
 * bundled renderTextLayer) lets the user select text and save a yellow
 * highlight, persisted via onCreateHighlight/onDeleteHighlight and repainted
 * on every (re)render including after a zoom change. Highlight granularity
 * is per pdf.js text-item span (its natural word/line-fragment chunks) --
 * simpler and far more robust than splitting DOM ranges mid-span, and still
 * gives an accurate-enough study highlighter. */
export async function renderPdf(container, url, { highlights = [], onCreateHighlight, onDeleteHighlight, onSnip } = {}) {
  container.innerHTML = `
    <div class="pdf-toolbar">
      <button class="sm pdf-zoom-out" title="Zoom out">－</button>
      <span class="pdf-zoom-label">100%</span>
      <button class="sm pdf-zoom-in" title="Zoom in">＋</button>
      <button class="sm pdf-zoom-reset" title="Reset zoom">Reset</button>
      ${onSnip ? `<span class="pdf-toolbar-spacer"></span>
      <span class="faint pdf-snip-hint" hidden>Drag over what you want explained · Esc to cancel</span>
      <button class="sm primary pdf-snip-btn" title="Snip: drag a box over any text, figure, formula or chemical equation (shortcut: S)">✂ Snip <kbd class="kbd">S</kbd></button>` : ""}
    </div>
    <div class="pdf-workspace">
      <div class="pdf-pages"></div>
      <aside class="snip-panel" hidden></aside>
    </div>
  `;
  const pagesBox = container.querySelector(".pdf-pages");
  const zoomLabel = container.querySelector(".pdf-zoom-label");
  let scale = PDF_BASE_SCALE;

  let pdf;
  try {
    pdf = await window.pdfjsLib.getDocument(url).promise;
  } catch (err) {
    container.innerHTML = `<p style="color:var(--red);">Could not render PDF: ${err.message}</p>`;
    return;
  }

  const highlightsByPage = new Map();
  for (const h of highlights) {
    if (!highlightsByPage.has(h.page_number)) highlightsByPage.set(h.page_number, []);
    highlightsByPage.get(h.page_number).push(h);
  }

  function paintHighlights(textLayerDiv, pageHighlights) {
    const spans = Array.from(textLayerDiv.children).filter((n) => n.tagName === "SPAN");
    let cursor = 0;
    for (const span of spans) {
      const len = (span.textContent || "").length;
      const start = cursor, end = cursor + len;
      cursor = end;
      span.classList.remove("pdf-highlight-mark");
      span.onclick = null;
      span.title = "";
      const match = pageHighlights.find((h) => h.start_offset < end && h.end_offset > start);
      if (match) {
        span.classList.add("pdf-highlight-mark");
        span.title = "Click to remove highlight";
        span.onclick = async (e) => {
          e.stopPropagation();
          if (onDeleteHighlight) await onDeleteHighlight(match.id);
          const idx = pageHighlights.indexOf(match);
          if (idx !== -1) pageHighlights.splice(idx, 1);
          paintHighlights(textLayerDiv, pageHighlights);
        };
      }
    }
  }

  function rangeToOffsets(textLayerDiv, range) {
    const spans = Array.from(textLayerDiv.children).filter((n) => n.tagName === "SPAN");
    let cursor = 0, start = null, end = null;
    for (const span of spans) {
      const len = (span.textContent || "").length;
      if (start === null && span.contains(range.startContainer)) start = cursor + range.startOffset;
      if (span.contains(range.endContainer)) end = cursor + range.endOffset;
      cursor += len;
    }
    if (start === null || end === null || end <= start) return null;
    return { start, end };
  }

  function setupSelection(pageWrap, textLayerDiv, pageNum, pageHighlights) {
    let selectBtn = null;
    const clearBtn = () => { if (selectBtn) { selectBtn.remove(); selectBtn = null; } };
    textLayerDiv.addEventListener("mouseup", () => {
      clearBtn();
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.toString().trim()) return;
      const range = sel.getRangeAt(0);
      if (!textLayerDiv.contains(range.commonAncestorContainer)) return;
      const offsets = rangeToOffsets(textLayerDiv, range);
      if (!offsets) return;
      const rect = range.getBoundingClientRect();
      const wrapRect = pageWrap.getBoundingClientRect();
      selectBtn = document.createElement("button");
      selectBtn.className = "pdf-highlight-btn";
      selectBtn.textContent = "🖍 Highlight";
      selectBtn.style.left = Math.max(0, rect.left - wrapRect.left) + "px";
      selectBtn.style.top = Math.max(0, rect.top - wrapRect.top - 30) + "px";
      selectBtn.onmousedown = (e) => e.preventDefault(); // keep the selection alive through the click
      selectBtn.onclick = async () => {
        const snippet = sel.toString().slice(0, 200);
        sel.removeAllRanges();
        clearBtn();
        if (!onCreateHighlight) return;
        const created = await onCreateHighlight({
          page_number: pageNum, start_offset: offsets.start, end_offset: offsets.end, snippet,
        });
        if (created) {
          pageHighlights.push(created);
          paintHighlights(textLayerDiv, pageHighlights);
        }
      };
      pageWrap.appendChild(selectBtn);
    });
  }

  // A page proxy's render()/getTextContent() calls are NOT safe to interrupt
  // and immediately reissue -- cancelling an in-flight render for a page and
  // starting a new one for that same page number right away reliably
  // deadlocks pdf.js internally (reproduced: the second render() call never
  // resolves). So zoom doesn't cancel a run in progress; it just remembers
  // that another one is wanted and runs it (once, with whatever scale is
  // current by then) right after the in-flight one finishes -- never two
  // concurrent passes over the same document.
  let renderRunning = false;
  let rerenderWanted = false;

  async function requestRender() {
    rerenderWanted = true;
    if (renderRunning) return;
    renderRunning = true;
    while (rerenderWanted) {
      rerenderWanted = false;
      await renderOnce();
    }
    renderRunning = false;
  }

  async function renderOnce() {
    pagesBox.innerHTML = "";
    zoomLabel.textContent = Math.round((scale / PDF_BASE_SCALE) * 100) + "%";
    try {
      for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
        const page = await pdf.getPage(pageNum);
        const viewport = page.getViewport({ scale });

        const pageWrap = document.createElement("div");
        pageWrap.className = "pdf-page-wrap";
        pageWrap.dataset.page = pageNum;
        pageWrap.style.width = viewport.width + "px";
        pageWrap.style.height = viewport.height + "px";
        pagesBox.appendChild(pageWrap);

        const canvas = document.createElement("canvas");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        pageWrap.appendChild(canvas);
        await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;

        const textContent = await page.getTextContent();
        const textLayerDiv = document.createElement("div");
        textLayerDiv.className = "textLayer";
        // pdf.js requires this custom property on the container (or an
        // ancestor) so it can size/position each text span to line up
        // exactly over the canvas glyphs beneath it.
        textLayerDiv.style.setProperty("--scale-factor", viewport.scale);
        pageWrap.appendChild(textLayerDiv);
        await window.pdfjsLib.renderTextLayer({ textContentSource: textContent, container: textLayerDiv, viewport }).promise;

        // Always the same array instance for a given page (created once, on
        // first render, and reused thereafter) -- a highlight added by the
        // user gets pushed into this exact array, so a later re-render
        // (zoom) still finds it instead of silently reverting to empty.
        if (!highlightsByPage.has(pageNum)) highlightsByPage.set(pageNum, []);
        const pageHighlights = highlightsByPage.get(pageNum);
        paintHighlights(textLayerDiv, pageHighlights);
        setupSelection(pageWrap, textLayerDiv, pageNum, pageHighlights);

        // pdf.js caches the same PDFPageProxy per page number -- without
        // releasing its rendered operator-list state, a later render() call
        // on that same proxy (e.g. after a zoom change) never resolves.
        page.cleanup();

        if (rerenderWanted) return; // a newer zoom is queued -- stop early, requestRender loops to it
      }
    } catch (err) {
      pagesBox.innerHTML = `<p style="color:var(--red); padding:12px;">Could not render page: ${err.message || err}</p>`;
    }
  }

  container.querySelector(".pdf-zoom-in").onclick = () => { scale = Math.min(3, scale + 0.28); requestRender(); };
  container.querySelector(".pdf-zoom-out").onclick = () => { scale = Math.max(0.56, scale - 0.28); requestRender(); };
  container.querySelector(".pdf-zoom-reset").onclick = () => { scale = PDF_BASE_SCALE; requestRender(); };

  // ---- Snip-to-ask: drag a box over a page, send that region (re-rendered at
  // high resolution so small print and subscripts stay legible) to the vision
  // model, show its transcription/explanation. ----
  if (onSnip) setupSnip();

  function setupSnip() {
    const snipBtn = container.querySelector(".pdf-snip-btn");
    const hint = container.querySelector(".pdf-snip-hint");
    const panel = container.querySelector(".snip-panel");
    let snipMode = false;
    let liveBox = null;

    function setSnipMode(on) {
      snipMode = on;
      pagesBox.classList.toggle("snipping", on);
      snipBtn.classList.toggle("active-mode", on);
      snipBtn.innerHTML = on ? "✕ Cancel" : `✂ Snip <kbd class="kbd">S</kbd>`;
      hint.hidden = !on;
    }
    snipBtn.onclick = () => setSnipMode(!snipMode);

    const onKey = (e) => {
      if (!container.isConnected) { document.removeEventListener("keydown", onKey); return; }
      if (e.key === "Escape") {
        if (snipMode) setSnipMode(false); else if (!panel.hidden) closePanel();
        return;
      }
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
      if ((e.key === "s" || e.key === "S") && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        setSnipMode(!snipMode);
      }
    };
    document.addEventListener("keydown", onKey);

    pagesBox.addEventListener("pointerdown", (e) => {
      if (!snipMode || e.button !== 0) return;
      const wrap = e.target.closest(".pdf-page-wrap");
      if (!wrap) return;
      e.preventDefault();
      const rect = wrap.getBoundingClientRect();
      const clampX = (v) => Math.max(0, Math.min(rect.width, v - rect.left));
      const clampY = (v) => Math.max(0, Math.min(rect.height, v - rect.top));
      const sx = clampX(e.clientX), sy = clampY(e.clientY);
      if (liveBox) liveBox.remove();
      liveBox = document.createElement("div");
      liveBox.className = "snip-box";
      wrap.appendChild(liveBox);
      const region = () => {
        const x = Math.min(sx, clampX(lastX)), y = Math.min(sy, clampY(lastY));
        return { x, y, w: Math.abs(clampX(lastX) - sx), h: Math.abs(clampY(lastY) - sy) };
      };
      let lastX = e.clientX, lastY = e.clientY;
      const paint = () => {
        const r = region();
        Object.assign(liveBox.style, { left: r.x + "px", top: r.y + "px", width: r.w + "px", height: r.h + "px" });
      };
      const move = (ev) => { lastX = ev.clientX; lastY = ev.clientY; paint(); };
      const up = (ev) => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        lastX = ev.clientX; lastY = ev.clientY;
        const r = region();
        if (r.w < 12 || r.h < 12) { liveBox.remove(); liveBox = null; return; }
        setSnipMode(false);
        startSnip(Number(wrap.dataset.page), wrap, r);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });

    async function captureRegion(pageNum, wrap, r) {
      const shown = wrap.querySelector("canvas");
      const cropShown = () => {
        const c = document.createElement("canvas");
        c.width = Math.round(r.w); c.height = Math.round(r.h);
        c.getContext("2d").drawImage(shown, r.x, r.y, r.w, r.h, 0, 0, c.width, c.height);
        return c;
      };
      const target = Math.min(3, (scale * 2400) / Math.max(r.w, r.h));
      if (target <= scale * 1.05 || renderRunning) return cropShown();
      // Re-render just this region at higher scale. Bounded by a timeout with
      // a fallback to the on-screen pixels (see the pdf.js render caveat above).
      const k = target / scale;
      const out = document.createElement("canvas");
      out.width = Math.max(1, Math.round(r.w * k)); out.height = Math.max(1, Math.round(r.h * k));
      let task = null, page = null;
      try {
        page = await pdf.getPage(pageNum);
        const viewport = page.getViewport({ scale: target });
        task = page.render({
          canvasContext: out.getContext("2d"), viewport, transform: [1, 0, 0, 1, -r.x * k, -r.y * k],
        });
        await Promise.race([task.promise, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 10000))]);
        return out;
      } catch (err) {
        console.warn("snip: high-res re-render failed, using on-screen pixels", err);
        try { task && task.cancel(); } catch { /* already done */ }
        return cropShown();
      } finally {
        if (page) page.cleanup();
      }
    }

    const workspace = container.querySelector(".pdf-workspace");
    const QUICK = [
      ["Explain simply", "Explain this simply, step by step, as to a smart newcomer."],
      ["Transcribe only", "Only transcribe exactly what is shown (LaTeX for math, \\ce{} for chemistry). No explanation."],
      ["Get LaTeX", "Give the exact LaTeX source for every equation shown, inside a fenced code block."],
      ["Key takeaway", "State the key takeaway in two sentences."],
    ];
    const snips = []; // { url, blob, page, answer, busy }
    let active = -1;

    const setPanelOpen = (open) => {
      panel.hidden = !open;
      workspace.classList.toggle("has-panel", open);
    };
    function closePanel() {
      snips.forEach((s) => URL.revokeObjectURL(s.url));
      snips.length = 0; active = -1;
      if (liveBox) { liveBox.remove(); liveBox = null; }
      panel.innerHTML = "";
      setPanelOpen(false);
    }

    async function ask(idx, question) {
      const s = snips[idx];
      if (!s || s.busy) return;
      s.busy = true; s.answer = null; s.error = null;
      if (idx === active) drawPanel();
      try {
        s.answer = (await onSnip(s.blob, question)).answer;
      } catch (err) {
        s.error = err.message || String(err);
      }
      s.busy = false;
      if (idx === active) drawPanel();
    }

    function drawPanel() {
      const s = snips[active];
      if (!s) return;
      panel.innerHTML = `
        <div class="snip-head">
          <strong>✂ Snip</strong><span class="faint">page ${s.page}</span>
          <span class="snip-head-actions">
            <button class="sm ghost-btn snip-copy" title="Copy answer" ${s.answer ? "" : "disabled"}>Copy</button>
            <button class="sm ghost-btn snip-close" title="Close (Esc)">✕</button>
          </span>
        </div>
        ${snips.length > 1 ? `<div class="snip-history">${snips.map((x, i) =>
          `<img src="${x.url}" data-i="${i}" class="${i === active ? "active" : ""}" title="Snip ${i + 1} · page ${x.page}">`).join("")}</div>` : ""}
        <img class="snip-thumb" src="${s.url}" alt="Snipped area">
        <div class="snip-chips">${QUICK.map(([label], i) => `<button class="sm chip" data-q="${i}">${label}</button>`).join("")}</div>
        <div class="snip-answer">${
          s.busy ? `<span class="spinner"></span> Reading the snip...`
          : s.error ? `<span style="color:var(--red);">${escapeHtmlLocal(s.error)}</span>`
          : formatSnipAnswer(s.answer)}</div>
        <div class="snip-followup">
          <input class="snip-question" placeholder="Ask a follow-up about this area…">
          <button class="sm primary snip-ask">Ask</button>
        </div>`;
      const answerEl = panel.querySelector(".snip-answer");
      if (s.answer) renderInlineMath(answerEl);
      const input = panel.querySelector(".snip-question");
      panel.querySelector(".snip-close").onclick = closePanel;
      panel.querySelector(".snip-copy").onclick = async (e) => {
        try { await navigator.clipboard.writeText(s.answer); e.target.textContent = "Copied ✓"; }
        catch { e.target.textContent = "Copy failed"; }
        setTimeout(() => { if (e.target.isConnected) e.target.textContent = "Copy"; }, 1500);
      };
      panel.querySelectorAll(".snip-history img").forEach((img) => {
        img.onclick = () => { active = Number(img.dataset.i); drawPanel(); };
      });
      panel.querySelectorAll(".snip-chips .chip").forEach((b) => {
        b.onclick = () => ask(active, QUICK[Number(b.dataset.q)][1]);
      });
      const go = () => { const q = input.value.trim(); if (q) ask(active, q); };
      panel.querySelector(".snip-ask").onclick = go;
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); go(); } });
    }

    async function startSnip(pageNum, wrap, r) {
      setPanelOpen(true);
      if (!snips.length) panel.innerHTML = `<div class="flex items-center gap-2"><span class="spinner"></span> Capturing…</div>`;
      let blob;
      try {
        const canvas = await captureRegion(pageNum, wrap, r);
        blob = await new Promise((res) => canvas.toBlob(res, "image/png"));
        if (!blob) throw new Error("Could not capture that area");
      } catch (err) {
        panel.innerHTML = `<span style="color:var(--red);">${escapeHtmlLocal(err.message || String(err))}</span>`;
        return;
      }
      if (liveBox) { liveBox.remove(); liveBox = null; }
      snips.push({ blob, url: URL.createObjectURL(blob), page: pageNum, answer: null, busy: false });
      if (snips.length > 8) { URL.revokeObjectURL(snips.shift().url); }
      active = snips.length - 1;
      drawPanel();
      ask(active, "");
    }
  }

  await requestRender();
}

function escapeHtmlLocal(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

/** Tiny markdown subset for snip answers: **bold**, `code`, pipe tables, line
 * breaks. Escapes first so model output can't inject HTML; $...$ / \ce{...}
 * pass through untouched for KaTeX. */
function formatSnipAnswer(text) {
  const fences = [];
  const escaped = escapeHtmlLocal(text || "").replace(/```[\w-]*\n?([\s\S]*?)```/g, (_, code) => {
    fences.push(`<pre class="code-block">${code.replace(/\n$/, "")}</pre>`);
    return `@@FENCE${fences.length - 1}@@`;
  });
  const lines = escaped.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const fence = lines[i].match(/^@@FENCE(\d+)@@$/);
    if (fence) { out.push(fences[Number(fence[1])]); continue; }
    if (/^\s*\|.*\|\s*$/.test(lines[i])) {
      const block = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) block.push(lines[i++]);
      i--;
      const rows = block.filter((l) => !/^\s*\|[\s|:-]+\|\s*$/.test(l))
        .map((l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
      const [head, ...body] = rows;
      out.push(`<table class="paper-table"><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${
        body.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
    } else {
      out.push(lines[i].replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/`([^`]+)`/g, "<code>$1</code>") + "<br>");
    }
  }
  return out.join("").replace(/@@FENCE(\d+)@@/g, (_, n) => fences[Number(n)]);
}

/** Pan/zoom viewer: scroll to zoom toward cursor, drag to pan, dblclick to reset. */
export function makeZoomable(container, imgUrl) {
  container.innerHTML = `<img class="zoom-img" src="${imgUrl}" draggable="false" style="position:absolute; transform-origin:0 0; user-select:none;">`;
  container.style.cssText += "overflow:hidden; position:relative; cursor:grab; background:#111;";
  const img = container.querySelector("img");
  let scale = 1, originX = 0, originY = 0, dragging = false, startX = 0, startY = 0;

  function update() {
    img.style.transform = `translate(${originX}px, ${originY}px) scale(${scale})`;
  }
  function fit() {
    const cw = container.clientWidth, ch = container.clientHeight;
    const iw = img.naturalWidth, ih = img.naturalHeight;
    if (!iw || !ih) return;
    scale = Math.min(cw / iw, ch / ih);
    originX = (cw - iw * scale) / 2;
    originY = (ch - ih * scale) / 2;
    update();
  }
  img.onload = fit;
  if (img.complete) fit();

  container.addEventListener("wheel", (e) => {
    e.preventDefault();
    const rect = container.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const newScale = Math.max(0.1, Math.min(10, scale * factor));
    originX = mx - (mx - originX) * (newScale / scale);
    originY = my - (my - originY) * (newScale / scale);
    scale = newScale;
    update();
  }, { passive: false });
  container.addEventListener("mousedown", (e) => {
    dragging = true; startX = e.clientX - originX; startY = e.clientY - originY;
    container.style.cursor = "grabbing";
  });
  window.addEventListener("mouseup", () => { dragging = false; container.style.cursor = "grab"; });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    originX = e.clientX - startX; originY = e.clientY - startY;
    update();
  });
  container.addEventListener("dblclick", fit);
}
