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
export async function renderPdf(container, url, { highlights = [], onCreateHighlight, onDeleteHighlight } = {}) {
  container.innerHTML = `
    <div class="pdf-toolbar">
      <button class="sm pdf-zoom-out" title="Zoom out">－</button>
      <span class="pdf-zoom-label">100%</span>
      <button class="sm pdf-zoom-in" title="Zoom in">＋</button>
      <button class="sm pdf-zoom-reset" title="Reset zoom">Reset</button>
    </div>
    <div class="pdf-pages"></div>
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

  await requestRender();
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
