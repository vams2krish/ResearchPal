import { api } from "../api.js";
import { toast, confirmDialog, el, escapeHtml } from "../ui.js";
import { navigate } from "../router.js";

const STATUS_COLOR = { processed: "green", uploaded: "gray" };

// ---- Progress-stream connection pool --------------------------------------
// Browsers cap concurrent HTTP/1.1 connections to a single origin at 6. With
// no cap here, opening one persistent EventSource per still-processing paper
// (there can easily be 10+ in a real batch) starved every other request on
// the page -- including the page's own initial load -- once the cap was hit,
// which looked like the whole app freezing on a loading screen. Cap how many
// progress streams run at once and queue the rest (they just show "Waiting
// in queue" until a slot frees). Keyed by paper id and kept at module scope
// (survives re-renders, since this is an SPA and the module isn't reloaded)
// so revisiting the library never opens a second connection for the same
// paper.
const MAX_CONCURRENT_STREAMS = 3;
let activeStreamCount = 0;
const streamQueue = [];
const trackers = new Map(); // paperId -> { card, fill, statusMsg, spinner, silent, title }

function runNextQueuedStream() {
  const next = streamQueue.shift();
  if (next) { activeStreamCount++; next(); }
}

export async function renderLibrary() {
  const root = document.getElementById("view-root");
  root.innerHTML = `
    <div class="page-header">
      <div class="page-title">📚 Your Library</div>
      <div class="toolbar">
        <button id="new-collection-btn">+ Collection</button>
        <a href="${api.exportAnkiUrl()}"><button>⬇ Export all flashcards (Anki)</button></a>
      </div>
    </div>
    <div id="dropzone" class="dropzone">
      <div style="font-size:28px;">📥</div>
      <div><strong>Drop PDF(s) here</strong> or click to browse — processed automatically</div>
      <input type="file" id="file-input" accept="application/pdf" multiple hidden>
    </div>
    <div id="upload-progress"></div>
    <div id="filters" class="flex gap-1" style="flex-wrap:wrap; margin-bottom:14px;"></div>
    <div class="flex items-center justify-between gap-2" style="margin-bottom:10px;">
      <select id="sort-select" class="sm">
        <option value="recent">Recently added</option>
        <option value="title">Title A-Z</option>
        <option value="oldest">Oldest first</option>
        <option value="favorites">Favorites first</option>
      </select>
      <button id="view-toggle-btn" class="sm ghost-btn icon-btn" title="Toggle view">▦</button>
    </div>
    <div id="papers-grid" class="grid"></div>
  `;

  const SORT_KEY = "library-sort";
  const VIEW_KEY = "library-view";
  const sortSelect = root.querySelector("#sort-select");
  const viewToggleBtn = root.querySelector("#view-toggle-btn");
  const grid = root.querySelector("#papers-grid");

  sortSelect.value = localStorage.getItem(SORT_KEY) || "recent";
  let viewMode = localStorage.getItem(VIEW_KEY) || "grid";
  const applyViewMode = () => {
    grid.classList.toggle("list", viewMode === "list");
    viewToggleBtn.textContent = viewMode === "list" ? "▦" : "☰";
    viewToggleBtn.title = viewMode === "list" ? "Switch to grid view" : "Switch to list view";
  };
  applyViewMode();
  viewToggleBtn.onclick = () => {
    viewMode = viewMode === "list" ? "grid" : "list";
    localStorage.setItem(VIEW_KEY, viewMode);
    applyViewMode();
  };
  sortSelect.onchange = () => {
    localStorage.setItem(SORT_KEY, sortSelect.value);
    loadPapers();
  };

  function sortPapers(papers) {
    const sorted = [...papers];
    switch (sortSelect.value) {
      case "title":
        sorted.sort((a, b) => a.title.localeCompare(b.title));
        break;
      case "oldest":
        sorted.sort((a, b) => new Date(a.added_at) - new Date(b.added_at));
        break;
      case "favorites":
        sorted.sort((a, b) => (b.is_favorite ? 1 : 0) - (a.is_favorite ? 1 : 0) || new Date(b.added_at) - new Date(a.added_at));
        break;
      default: // recent
        sorted.sort((a, b) => new Date(b.added_at) - new Date(a.added_at));
    }
    return sorted;
  }

  const dropzone = root.querySelector("#dropzone");
  const fileInput = root.querySelector("#file-input");
  dropzone.onclick = () => fileInput.click();
  dropzone.addEventListener("dragover", (e) => { e.preventDefault(); dropzone.classList.add("dragover"); });
  dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));
  dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
    handleFiles(e.dataTransfer.files);
  });
  fileInput.addEventListener("change", () => handleFiles(fileInput.files));

  root.querySelector("#new-collection-btn").onclick = async () => {
    const name = prompt("Collection name:");
    if (name) { await api.createCollection(name); renderFilters(); }
  };

  let activeTagFilter = null;
  let activeCollectionFilter = null;

  async function renderFilters() {
    const [tags, collections] = await Promise.all([api.listTags(), api.listCollections()]);
    const box = root.querySelector("#filters");
    box.innerHTML = "";
    if (activeTagFilter || activeCollectionFilter) {
      const clear = el(`<button class="sm">✕ Clear filter</button>`);
      clear.onclick = () => { activeTagFilter = null; activeCollectionFilter = null; renderFilters(); loadPapers(); };
      box.appendChild(clear);
    }
    for (const c of collections) {
      const active = activeCollectionFilter === c.id;
      const b = el(`<button class="sm" style="${active ? 'border-color:var(--accent-strong);color:var(--accent);' : ''}">🗂 ${escapeHtml(c.name)} (${c.paper_count})</button>`);
      b.onclick = () => { activeCollectionFilter = c.id; activeTagFilter = null; renderFilters(); loadPapers(); };
      box.appendChild(b);
    }
    for (const t of tags) {
      const active = activeTagFilter === t.name;
      const b = el(`<button class="sm" style="${active ? 'border-color:var(--accent-strong);color:var(--accent);' : ''}">🏷 ${escapeHtml(t.name)} (${t.paper_count})</button>`);
      b.onclick = () => { activeTagFilter = t.name; activeCollectionFilter = null; renderFilters(); loadPapers(); };
      box.appendChild(b);
    }
  }

  async function loadPapers() {
    grid.innerHTML = `<div class="muted">Loading...</div>`;
    let papers = await api.listPapers();
    if (activeCollectionFilter) {
      const inColl = await api.collectionPapers(activeCollectionFilter);
      const ids = new Set(inColl.map((p) => p.id));
      papers = papers.filter((p) => ids.has(p.id));
    } else if (activeTagFilter) {
      papers = papers.filter((p) => (p.tags || []).includes(activeTagFilter));
    }
    if (!papers.length) {
      grid.innerHTML = `<div class="empty-state"><div class="icon">👋</div>
        <p><strong>Welcome!</strong> Upload your first research paper above. It'll be broken down
        into its anatomy, with real typeset formulas, figures, tables, code, a mind map,
        flashcards, and more.</p></div>`;
      return;
    }
    grid.innerHTML = "";
    for (const p of sortPapers(papers)) grid.appendChild(paperCard(p));
  }

  function paperCard(p) {
    const notProcessed = p.status !== "processed";
    const card = el(`
      <div class="card paper-card">
        <div class="flex justify-between items-center">
          <span class="badge-pill ${STATUS_COLOR[p.status] || "gray"}">${p.status}</span>
          <span class="flex items-center gap-1">
            <button class="icon-btn ghost-btn sm star-btn ${p.is_favorite ? "active" : ""}" title="${p.is_favorite ? "Unfavorite" : "Favorite"}">${p.is_favorite ? "★" : "☆"}</button>
            <button class="icon-btn ghost-btn sm delete-btn" title="Delete">🗑️</button>
          </span>
        </div>
        <div class="paper-card-title">${escapeHtml(p.title)}</div>
        <div class="paper-card-meta">${[p.authors, p.venue, p.year].filter(Boolean).map(escapeHtml).join(" · ") || new Date(p.added_at).toLocaleDateString()}</div>
        <div class="paper-card-summary">${escapeHtml(p.one_liner || "")}</div>
        <div class="paper-card-tags"></div>
        ${notProcessed ? `
          <div class="progress-track"><div class="progress-fill" style="width:3%"></div></div>
          <div class="text-sm faint status-msg">⏳ Waiting in queue...</div>
        ` : ""}
        <div class="paper-card-actions">
          <button class="sm open-btn" ${notProcessed ? "disabled" : ""}>Open</button>
          <button class="sm ghost-btn tag-btn">+ Tag</button>
        </div>
      </div>
    `);
    if (notProcessed) trackProgress(p.id, card, p.title, { silent: true });
    const tagsBox = card.querySelector(".paper-card-tags");
    for (const t of p.tags || []) {
      const chip = el(`<span class="tag-chip">${escapeHtml(t)}<button title="Remove">✕</button></span>`);
      chip.querySelector("button").onclick = async (e) => {
        e.stopPropagation();
        await api.removeTag(p.id, t);
        loadPapers();
      };
      tagsBox.appendChild(chip);
    }
    card.querySelector(".star-btn").onclick = async (e) => {
      e.stopPropagation();
      const next = !p.is_favorite;
      p.is_favorite = next;
      const btn = e.currentTarget;
      btn.textContent = next ? "★" : "☆";
      btn.classList.toggle("active", next);
      btn.title = next ? "Unfavorite" : "Favorite";
      try {
        await api.setFavorite(p.id, next);
        if (sortSelect.value === "favorites") loadPapers();
      } catch (err) {
        p.is_favorite = !next;
        btn.textContent = !next ? "★" : "☆";
        btn.classList.toggle("active", !next);
        toast(`Couldn't update favorite: ${err.message}`, "error");
      }
    };
    card.querySelector(".open-btn").onclick = () => navigate(`/paper/${p.id}`);
    card.addEventListener("click", (e) => {
      if (p.status === "processed" && !e.target.closest("button")) navigate(`/paper/${p.id}`);
    });
    card.querySelector(".delete-btn").onclick = (e) => {
      e.stopPropagation();
      confirmDialog(`Permanently delete "${p.title}" and everything extracted from it?`, async () => {
        await api.deletePaper(p.id);
        toast("Paper deleted");
        loadPapers();
      });
    };
    card.querySelector(".tag-btn").onclick = async (e) => {
      e.stopPropagation();
      const name = prompt("Tag name:");
      if (name) { await api.addTag(p.id, name); loadPapers(); renderFilters(); }
    };
    return card;
  }

  function handleFiles(fileList) {
    const all = Array.from(fileList);
    // Filter by extension, not MIME type -- some browsers/OSes (especially
    // via drag-and-drop) don't reliably report "application/pdf" as the
    // type, which silently dropped valid PDFs with zero feedback.
    const files = all.filter((f) => f.name.toLowerCase().endsWith(".pdf"));
    const rejected = all.filter((f) => !f.name.toLowerCase().endsWith(".pdf"));
    if (rejected.length) {
      toast(`Skipped ${rejected.length} non-PDF file(s): ${rejected.map((f) => f.name).join(", ")}`, "error");
    }
    if (!files.length) return;
    uploadAndTrack(files);
  }

  async function uploadAndTrack(files) {
    const progressBox = root.querySelector("#upload-progress");
    const banner = el(`<div class="card" style="margin-bottom:16px;">
      <div class="flex items-center gap-2"><span class="spinner"></span> Uploading ${files.length} file(s)...</div>
    </div>`);
    progressBox.appendChild(banner);

    let res;
    try {
      res = await api.uploadPapers(files);
    } catch (err) {
      banner.innerHTML = `<span style="color:var(--red);">Upload failed: ${err.message}</span>`;
      return;
    }
    banner.remove();

    const { created, skipped_duplicate, failed } = res;
    if (skipped_duplicate.length) {
      toast(`Already in your library, skipped: ${skipped_duplicate.join(", ")}`);
    }
    if (failed.length) {
      const box = el(`<div class="card" style="margin-bottom:10px; border-color:var(--red);"></div>`);
      box.innerHTML = `<strong style="color:var(--red);">${failed.length} file(s) failed to process:</strong>` +
        failed.map((f) => `<div class="text-sm mt-1">${escapeHtml(f.filename)} — ${escapeHtml(f.error)}</div>`).join("");
      progressBox.appendChild(box);
    }
    if (!created.length) return;

    for (const { id, title } of created) {
      const card = el(`
        <div class="card" style="margin-bottom:10px;">
          <div class="flex justify-between items-center">
            <strong>${escapeHtml(title)}</strong>
            <span class="spinner"></span>
          </div>
          <div class="progress-track mt-1"><div class="progress-fill" style="width:5%"></div></div>
          <div class="faint mt-1 status-msg">Queued...</div>
        </div>
      `);
      progressBox.appendChild(card);
      trackProgress(id, card, title);
    }
  }

  function trackProgress(paperId, card, title, { silent = false } = {}) {
    const fill = card.querySelector(".progress-fill");
    const statusMsg = card.querySelector(".status-msg");
    const spinner = card.querySelector(".spinner");

    let t = trackers.get(paperId);
    if (t) {
      // Already tracking (or queued to track) this paper -- e.g. loadPapers()
      // re-rendered the grid. Repoint at the fresh card instead of opening a
      // second EventSource for the same paper.
      t.card = card; t.fill = fill; t.statusMsg = statusMsg; t.spinner = spinner;
      t.silent = silent; t.title = title;
      return;
    }
    t = { card, fill, statusMsg, spinner, silent, title };
    trackers.set(paperId, t);

    const start = () => {
      const TOTAL_STEPS = 10;
      let n = 0;
      const es = new EventSource(api.progressStreamUrl(paperId));
      const finish = () => {
        es.close();
        trackers.delete(paperId);
        activeStreamCount--;
        runNextQueuedStream();
      };
      es.onmessage = (e) => {
        const msg = e.data;
        if (msg.startsWith("__DONE__")) {
          const state = msg.split(":")[1]; // "processed" (real completion) or "unknown" (lost queue entry)
          if (state === "unknown") {
            if (t.statusMsg) t.statusMsg.innerHTML = `<span style="color:var(--orange);">Lost track of this paper's progress (likely a server restart). Delete and re-upload it.</span>`;
            if (t.spinner) t.spinner.remove();
            finish();
            return;
          }
          if (t.fill) t.fill.style.width = "100%";
          if (t.statusMsg) t.statusMsg.textContent = "✅ Ready";
          if (t.spinner) t.spinner.remove();
          if (!t.silent) toast(`"${t.title}" is ready`, "success");
          setTimeout(() => { t.card.remove(); loadPapers(); }, 900);
          finish();
          return;
        }
        if (msg.startsWith("__ERROR__")) {
          if (t.statusMsg) t.statusMsg.innerHTML = `<span style="color:var(--red);">${escapeHtml(msg.replace("__ERROR__:", ""))}</span>`;
          if (t.spinner) t.spinner.remove();
          finish();
          return;
        }
        n += 1;
        if (t.fill) t.fill.style.width = `${Math.min((n / TOTAL_STEPS) * 100, 100)}%`;
        if (t.statusMsg) t.statusMsg.textContent = msg;
      };
      es.onerror = () => finish();
    };

    if (activeStreamCount < MAX_CONCURRENT_STREAMS) {
      activeStreamCount++;
      start();
    } else {
      streamQueue.push(start);
    }
  }

  renderFilters();
  loadPapers();
}
