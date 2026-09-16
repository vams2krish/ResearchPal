import { api } from "../api.js";
import { toast, confirmDialog, el, escapeHtml, showModal, closeModal } from "../ui.js";
import { renderLatex, renderInlineMath, renderMermaid, renderMarkmap, renderPdf, makeZoomable } from "../render.js";

const DOMAIN_COLOR = { Math: "blue", Physics: "violet", Chemistry: "green", Biology: "orange", "Computer Science": "gray", Other: "gray" };
const CARD_COLOR = { definition: "blue", equation: "violet", claim: "orange", comparison: "green" };
const SECTION_ICON = {
  "Title and Abstract": "📌", "Introduction": "🚪", "Methods": "🔧", "Experimental Setup": "🧪",
  "Results": "📊", "Related Work": "🕸️", "Discussion": "💬", "Conclusion": "🏁",
  "References": "📚", "Appendix": "📎",
};

let voices = null;

export async function renderPaper({ id, _query }) {
  const root = document.getElementById("view-root");
  root.innerHTML = `<div class="muted">Loading...</div>`;

  let data;
  try {
    data = await api.getPaper(id);
  } catch (err) {
    root.innerHTML = `<div class="empty-state"><div class="icon">⚠️</div><p>${err.message}</p></div>`;
    return;
  }
  if (!voices) voices = await api.listVoices().catch(() => []);

  const { paper, sections, equations, images, tables, claims, flashcards, diagram, glossary, notes, tags, mental_models, read_progress, pdf_url, first_principles } = data;
  const mentalModels = mental_models;

  const bySection = Object.fromEntries(sections.map((s) => [s.name, s]));
  const eqBySection = groupBy(equations, "section_name");
  const imgBySection = groupBy(images, "section_name");
  const tblBySection = groupBy(tables, "section_name");
  const notesBySection = groupBy(notes, "section_name");

  const tocSections = sections.map((s) => s.name);
  const tocTools = [];
  if (sections.length) tocTools.push({ key: "mindmap", label: "🧠 Mind Map" });
  if (diagram && diagram.mermaid_code) tocTools.push({ key: "diagram", label: "🗺️ Diagram" });
  if (claims.length) tocTools.push({ key: "claims", label: `🔍 Claims (${claims.length})` });
  if (first_principles.length) tocTools.push({ key: "firstprinciples", label: `⚛️ First Principles (${first_principles.length})` });
  if (flashcards.length) tocTools.push({ key: "flashcards", label: `🎴 Flashcards (${flashcards.length})` });
  if (glossary.length) tocTools.push({ key: "glossary", label: `📖 Glossary (${glossary.length})` });
  tocTools.push({ key: "mentalmodels", label: `🧭 Mental Models${mentalModels.length ? ` (${mentalModels.length})` : ""}` });
  tocTools.push({ key: "ask", label: "💬 Ask This Paper" });
  tocTools.push({ key: "humannotes", label: "✍️ Human Written Notes" });
  if (pdf_url) tocTools.push({ key: "pdf", label: "📄 Original PDF" });

  let current = tocSections[0] || tocTools[0]?.key;

  root.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-title">${escapeHtml(paper.title)}</div>
        <div class="faint mt-1">${[paper.authors, paper.venue, paper.year].filter(Boolean).map(escapeHtml).join(" · ")}</div>
        <div class="paper-card-tags mt-1" id="paper-tags"></div>
      </div>
      <div class="toolbar">
        <button id="star-btn" class="sm icon-btn ghost-btn ${paper.is_favorite ? "active star-btn" : "star-btn"}" title="${paper.is_favorite ? "Unfavorite" : "Favorite"}">${paper.is_favorite ? "★" : "☆"}</button>
        <button id="add-tag-btn" class="sm">+ Tag</button>
        <a href="${api.exportMarkdownUrl(id)}"><button class="sm">⬇ Markdown</button></a>
        <a href="${api.exportBibtexUrl(id)}" target="_blank"><button class="sm">⬇ BibTeX</button></a>
        <a href="${api.exportAnkiUrl([id])}"><button class="sm">⬇ Anki</button></a>
      </div>
    </div>
    ${paper.one_liner ? `<div class="oneliner">${escapeHtml(paper.one_liner)}</div>` : ""}
    ${read_progress.total ? `
      <div class="flex items-center gap-2 mt-1" style="margin-bottom:16px;">
        <div class="progress-track" style="flex:1;"><div class="progress-fill" style="width:${read_progress.pct}%"></div></div>
        <span class="faint">${read_progress.done}/${read_progress.total} sections read</span>
      </div>` : ""}
    <div class="reader-layout">
      <div class="reader-toc" id="reader-toc"></div>
      <div class="reader-content" id="reader-content"></div>
    </div>
  `;

  const tagsBox = root.querySelector("#paper-tags");
  function renderTags() {
    tagsBox.innerHTML = "";
    for (const t of tags) {
      const chip = el(`<span class="tag-chip">${escapeHtml(t)}<button title="Remove">✕</button></span>`);
      chip.querySelector("button").onclick = async () => { await api.removeTag(id, t); tags.splice(tags.indexOf(t), 1); renderTags(); };
      tagsBox.appendChild(chip);
    }
  }
  renderTags();
  root.querySelector("#star-btn").onclick = async (e) => {
    const btn = e.currentTarget;
    const next = !paper.is_favorite;
    paper.is_favorite = next;
    btn.textContent = next ? "★" : "☆";
    btn.classList.toggle("active", next);
    btn.title = next ? "Unfavorite" : "Favorite";
    try {
      await api.setFavorite(id, next);
    } catch (err) {
      paper.is_favorite = !next;
      btn.textContent = !next ? "★" : "☆";
      btn.classList.toggle("active", !next);
      toast(`Couldn't update favorite: ${err.message}`, "error");
    }
  };
  root.querySelector("#add-tag-btn").onclick = async () => {
    const name = prompt("Tag name:");
    if (name) { await api.addTag(id, name); tags.push(name); renderTags(); }
  };

  const tocBox = root.querySelector("#reader-toc");
  const contentBox = root.querySelector("#reader-content");

  function renderToc() {
    tocBox.innerHTML = `<div class="toc-label">Paper Anatomy</div>`;
    for (const name of tocSections) {
      const sec = bySection[name];
      const item = el(`
        <div class="toc-item ${current === name ? "active" : ""}" data-key="${name}">
          <span>${SECTION_ICON[name] || "•"}</span><span>${escapeHtml(name)}</span>
          ${sec.is_read ? '<span class="done-mark">✓</span>' : ""}
        </div>`);
      item.onclick = () => { current = name; renderToc(); renderContent(); };
      tocBox.appendChild(item);
    }
    if (tocTools.length) {
      tocBox.appendChild(el(`<div class="toc-label">Analysis Tools</div>`));
      for (const tool of tocTools) {
        const item = el(`<div class="toc-item ${current === tool.key ? "active" : ""}" data-key="${tool.key}">${tool.label}</div>`);
        item.onclick = () => { current = tool.key; renderToc(); renderContent(); };
        tocBox.appendChild(item);
      }
    }
  }

  function renderContent() {
    contentBox.innerHTML = "";
    if (bySection[current]) return renderSection(bySection[current]);
    const toolRenderers = {
      mindmap: renderMindmapView, diagram: renderDiagramView, claims: renderClaimsView,
      firstprinciples: renderFirstPrinciplesView,
      flashcards: renderFlashcardsView, glossary: renderGlossaryView, mentalmodels: renderMentalModelsView,
      ask: renderAskView, pdf: renderPdfView, humannotes: renderHumanNotesView,
    };
    (toolRenderers[current] || (() => {}))();
  }

  function renderSection(sec) {
    const head = el(`
      <div class="section-head">
        <h2>${SECTION_ICON[sec.name] || ""} ${escapeHtml(sec.name)}</h2>
        <div class="section-actions">
          <label class="flex items-center gap-1 text-sm"><input type="checkbox" id="read-check" ${sec.is_read ? "checked" : ""}> Mark read</label>
          <select id="voice-select" class="sm"></select>
          <button id="listen-btn" class="sm">🔊 Listen</button>
        </div>
      </div>
    `);
    contentBox.appendChild(head);
    const voiceSelect = head.querySelector("#voice-select");
    voiceSelect.innerHTML = voices.map((v) => `<option>${v}</option>`).join("");

    head.querySelector("#read-check").onchange = async (e) => {
      await api.markSectionRead(sec.id, e.target.checked);
      sec.is_read = e.target.checked ? 1 : 0;
      read_progress.done += e.target.checked ? 1 : -1;
      read_progress.pct = Math.round((100 * read_progress.done) / read_progress.total);
      renderToc();
      root.querySelector(".progress-fill").style.width = read_progress.pct + "%";
      root.querySelector(".faint").textContent = `${read_progress.done}/${read_progress.total} sections read`;
    };

    const audioContainer = el(`<div class="mt-1"></div>`);
    contentBox.appendChild(audioContainer);
    head.querySelector("#listen-btn").onclick = async () => {
      const btn = head.querySelector("#listen-btn");
      btn.disabled = true; btn.textContent = "Synthesizing...";
      try {
        const res = await fetch(api.audioUrlFor(), {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: sec.explanation, voice: voiceSelect.value }),
        });
        const blob = await res.blob();
        audioContainer.innerHTML = `<audio controls autoplay src="${URL.createObjectURL(blob)}" style="width:100%;"></audio>`;
      } catch (err) {
        toast("Audio synthesis failed: " + err.message, "error");
      }
      btn.disabled = false; btn.textContent = "🔊 Listen";
    };

    const body = el(`<div>${sec.explanation ? escapeHtml(sec.explanation).replace(/\n/g, "<br>") : '<span class="muted">No explanation generated for this section.</span>'}</div>`);
    contentBox.appendChild(body);
    renderInlineMath(body);

    const secEquations = eqBySection[sec.name] || [];
    if (secEquations.length) {
      contentBox.appendChild(el(`<h4 class="mt-2">🧮 Formulas</h4>`));
      for (const eq of secEquations) {
        const card = el(`
          <div class="card formula-card">
            <span class="badge-pill ${DOMAIN_COLOR[eq.domain] || "gray"}">${eq.domain || "Other"}</span>
            <div class="katex-box mt-1" style="overflow-x:auto;"></div>
            <p class="mt-1"><strong>In plain words:</strong> ${escapeHtml(eq.plain_explanation)}</p>
            <p><strong>Why it matters:</strong> ${escapeHtml(eq.practical_meaning)}</p>
          </div>`);
        contentBox.appendChild(card);
        renderLatex(card.querySelector(".katex-box"), eq.equation_raw);
      }
    }

    const secImages = imgBySection[sec.name] || [];
    if (secImages.length) {
      contentBox.appendChild(el(`<h4 class="mt-2">🖼️ Figures</h4>`));
      const grid = el(`<div class="figures-grid"></div>`);
      contentBox.appendChild(grid);
      for (const img of secImages) {
        const thumb = el(`
          <div>
            <div class="figure-thumb"><img src="${img.url}" loading="lazy"></div>
            ${img.caption ? `<div class="caption">${escapeHtml(img.caption)}</div>` : ""}
          </div>`);
        thumb.querySelector(".figure-thumb").onclick = () => openFigureModal(img);
        grid.appendChild(thumb);
      }
    }

    const secTables = tblBySection[sec.name] || [];
    if (secTables.length) {
      contentBox.appendChild(el(`<h4 class="mt-2">📋 Tables</h4>`));
      for (const t of secTables) {
        if (t.caption) contentBox.appendChild(el(`<div class="caption">${escapeHtml(t.caption)}</div>`));
        contentBox.appendChild(el(`<div style="overflow-x:auto;">${markdownTableToHtml(t.markdown)}</div>`));
      }
    }

    if (sec.code_snippet) {
      contentBox.appendChild(el(`<h4 class="mt-2">💻 Code / Algorithm</h4>`));
      contentBox.appendChild(el(`<pre class="code-block">${escapeHtml(sec.code_snippet)}</pre>`));
    }

    renderNotesPanel(sec.name);

    const rawToggle = el(`
      <details class="raw-text-toggle"><summary class="muted text-sm">Show raw extracted text</summary>
      <pre>${escapeHtml(sec.raw_text.slice(0, 5000))}</pre></details>`);
    contentBox.appendChild(rawToggle);
  }

  function renderNotesPanel(sectionName) {
    contentBox.appendChild(el(`<h4 class="mt-2">📝 Notes</h4>`));
    const box = el(`<div id="notes-box"></div>`);
    contentBox.appendChild(box);
    const addRow = el(`
      <div class="flex gap-1 mt-1">
        <textarea id="new-note" placeholder="Add a note on this section..." rows="2" style="flex:1;"></textarea>
        <button id="add-note-btn">Add</button>
      </div>`);
    contentBox.appendChild(addRow);

    function draw() {
      box.innerHTML = "";
      const mine = notesBySection[sectionName] || [];
      for (const n of mine) {
        const card = el(`
          <div class="card note-card">
            <div>${escapeHtml(n.content).replace(/\n/g, "<br>")}</div>
            <div class="flex justify-between items-center mt-1">
              <span class="faint">${new Date(n.updated_at).toLocaleString()}</span>
              <button class="sm ghost-btn danger">Delete</button>
            </div>
          </div>`);
        card.querySelector("button").onclick = async () => {
          await api.deleteNote(n.id);
          const idx = notesBySection[sectionName].indexOf(n);
          notesBySection[sectionName].splice(idx, 1);
          draw();
        };
        box.appendChild(card);
      }
    }
    draw();
    addRow.querySelector("#add-note-btn").onclick = async () => {
      const ta = addRow.querySelector("#new-note");
      if (!ta.value.trim()) return;
      const { id: noteId } = await api.createNote(id, sectionName, ta.value.trim());
      notesBySection[sectionName] = notesBySection[sectionName] || [];
      notesBySection[sectionName].push({ id: noteId, content: ta.value.trim(), updated_at: new Date().toISOString() });
      ta.value = "";
      draw();
    };
  }

  function openFigureModal(img) {
    const box = showModal(`
      <div class="modal-head"><h3>Figure</h3><button class="ghost-btn" id="close-modal">✕</button></div>
      <div id="zoom-viewport" style="width:100%; height:65vh;"></div>
      ${img.caption ? `<div class="caption mt-1">${escapeHtml(img.caption)}</div>` : ""}
    `);
    box.querySelector("#close-modal").onclick = closeModal;
    makeZoomable(box.querySelector("#zoom-viewport"), img.url);
  }

  function renderMindmapView() {
    contentBox.innerHTML = `<h2>🧠 Mind Map</h2><p class="muted text-sm">Click any node to expand or collapse it. Scroll to zoom, drag to pan.</p><div id="mindmap-box" style="width:100%; height:540px;"></div>`;
    api.getMindmap(id).then((tree) => renderMarkmap(contentBox.querySelector("#mindmap-box"), tree));
  }

  function renderDiagramView() {
    contentBox.innerHTML = `<h2>🗺️ Process / Architecture Diagram</h2><div id="diagram-box" style="width:100%; min-height:420px;"></div>`;
    renderMermaid(contentBox.querySelector("#diagram-box"), diagram.mermaid_code);
  }

  function renderClaimsView() {
    contentBox.innerHTML = `<h2>🔍 Claim Cards (${claims.length})</h2>`;
    for (const c of claims) {
      contentBox.appendChild(el(`
        <div class="card claim-card">
          <strong>${escapeHtml(c.claim)}</strong>
          <div class="grid" style="grid-template-columns:1fr 1fr; margin-top:8px;">
            <div><strong class="text-sm">Evidence</strong><p class="text-sm">${escapeHtml(c.evidence)}</p>
                 <strong class="text-sm">Assumptions</strong><p class="text-sm">${escapeHtml(c.assumptions)}</p></div>
            <div><strong class="text-sm">Limitations</strong><p class="text-sm">${escapeHtml(c.limitations)}</p></div>
          </div>
        </div>`));
    }
  }

  function renderFirstPrinciplesView() {
    contentBox.innerHTML = `
      <h2>⚛️ First Principles Breakdown</h2>
      <p class="muted text-sm">The paper's core contribution decomposed into a chain of undeniable, self-evident
      truths -- each one building on the last, not by analogy or comparison to other known systems.</p>
      <div class="first-principles-timeline mt-2"></div>
    `;
    const box = contentBox.querySelector(".first-principles-timeline");
    first_principles.forEach((fp, i) => {
      box.appendChild(el(`
        <div class="fp-step">
          <div class="fp-step-num">${i + 1}</div>
          <div class="fp-step-body">${escapeHtml(fp.statement)}</div>
        </div>`));
    });
  }

  function renderFlashcardsView() {
    contentBox.innerHTML = `<h2>🎴 Flashcards (${flashcards.length})</h2><p class="muted text-sm">Review these for real in the Review tab, on their spaced-repetition schedule.</p>`;
    for (const c of flashcards) {
      contentBox.appendChild(el(`
        <div class="card flash-card">
          <span class="badge-pill ${CARD_COLOR[c.card_type] || "gray"}">${c.card_type}</span>
          <p class="mt-1"><strong>Q:</strong> ${escapeHtml(c.front)}</p>
          <p><strong>A:</strong> ${escapeHtml(c.back)}</p>
        </div>`));
    }
  }

  function renderGlossaryView() {
    contentBox.innerHTML = `<h2>📖 Glossary (${glossary.length})</h2>`;
    for (const g of glossary) {
      contentBox.appendChild(el(`<div class="card glossary-card"><strong>${escapeHtml(g.term)}</strong><p class="mt-1">${escapeHtml(g.definition)}</p></div>`));
    }
  }

  function renderMentalModelsView() {
    contentBox.innerHTML = `
      <h2>🧭 Mental Models</h2>
      <p class="muted text-sm">Frameworks of thinking this paper exemplifies, relies on, or challenges --
      for cross-domain pattern recognition, not just a topic label.</p>
      <div class="flex gap-1 mt-1">
        <button id="suggest-models-btn" class="sm">✨ Suggest from paper</button>
        <button id="add-model-btn" class="sm ghost-btn">+ Add manually</button>
      </div>
      <div id="tagged-models" class="mt-2"></div>
      <div id="suggested-models" class="mt-2"></div>
    `;
    const taggedBox = contentBox.querySelector("#tagged-models");
    const suggestedBox = contentBox.querySelector("#suggested-models");

    function refreshTabLabel() {
      const tool = tocTools.find((t) => t.key === "mentalmodels");
      if (tool) tool.label = `🧭 Mental Models${mentalModels.length ? ` (${mentalModels.length})` : ""}`;
    }

    function drawTagged() {
      taggedBox.innerHTML = mentalModels.length ? "" : `<p class="muted text-sm">No mental models tagged yet.</p>`;
      for (const m of mentalModels) {
        const card = el(`
          <div class="card">
            <div class="flex justify-between items-center">
              <strong>${escapeHtml(m.name)}</strong>
              <button class="sm ghost-btn danger">Remove</button>
            </div>
            ${m.description ? `<p class="text-sm faint mt-1">${escapeHtml(m.description)}</p>` : ""}
            ${m.note ? `<p class="text-sm mt-1">${escapeHtml(m.note)}</p>` : ""}
          </div>`);
        card.querySelector("button").onclick = async () => {
          await api.removeMentalModel(id, m.id);
          mentalModels.splice(mentalModels.indexOf(m), 1);
          drawTagged();
          refreshTabLabel();
          renderToc();
        };
        taggedBox.appendChild(card);
      }
    }
    drawTagged();

    contentBox.querySelector("#add-model-btn").onclick = async () => {
      const name = prompt("Mental model name:");
      if (!name || !name.trim()) return;
      const note = prompt("Note -- how does this paper exemplify, rely on, or challenge it? (optional):") || "";
      const { id: modelId } = await api.addMentalModel(id, name.trim(), note.trim());
      mentalModels.push({ id: modelId, name: name.trim(), description: "", note: note.trim() });
      drawTagged();
      refreshTabLabel();
      renderToc();
    };

    contentBox.querySelector("#suggest-models-btn").onclick = async (e) => {
      const btn = e.target;
      btn.disabled = true; btn.textContent = "Thinking...";
      try {
        const suggestions = await api.suggestMentalModels(id);
        suggestedBox.innerHTML = suggestions.length
          ? `<h4>Suggestions — click to add</h4>`
          : `<p class="muted text-sm">No suggestions found.</p>`;
        for (const s of suggestions) {
          const already = mentalModels.some((m) => m.name.toLowerCase() === s.name.toLowerCase());
          const chip = el(`
            <div class="card" style="cursor:${already ? "default" : "pointer"}; opacity:${already ? 0.5 : 1};">
              <strong>${escapeHtml(s.name)}</strong>${already ? ' <span class="faint">(already tagged)</span>' : ' <span class="faint">click to add</span>'}
              <p class="text-sm mt-1">${escapeHtml(s.note || "")}</p>
            </div>`);
          if (!already) {
            chip.onclick = async () => {
              const { id: modelId } = await api.addMentalModel(id, s.name, s.note || "");
              mentalModels.push({ id: modelId, name: s.name, description: "", note: s.note || "" });
              drawTagged();
              refreshTabLabel();
              renderToc();
              chip.remove();
            };
          }
          suggestedBox.appendChild(chip);
        }
      } catch (err) {
        suggestedBox.innerHTML = `<span style="color:var(--red);">${err.message}</span>`;
      }
      btn.disabled = false; btn.textContent = "✨ Suggest from paper";
    };
  }

  function renderPdfView() {
    contentBox.innerHTML = `
      <h2>📄 Original PDF</h2>
      <div class="card pdf-audio-bar">
        <div class="flex items-center gap-2" style="flex-wrap:wrap;">
          <select id="pdf-voice-select" class="sm"></select>
          <button id="pdf-audio-btn" class="sm">🔊 Generate full narration</button>
          <select id="pdf-jump-select" class="sm" hidden><option value="">Jump to section...</option></select>
        </div>
        <audio id="pdf-audio" controls style="width:100%; margin-top:8px;" hidden></audio>
      </div>
      <p class="muted text-sm mt-1">The original source material this paper's entire breakdown is grounded in.
      Scroll to read, zoom with the controls below, and select any text to save a yellow highlight for later study.</p>
      <div id="pdf-box"></div>
    `;

    const voiceSelect = contentBox.querySelector("#pdf-voice-select");
    voiceSelect.innerHTML = voices.map((v) => `<option>${v}</option>`).join("");
    contentBox.querySelector("#pdf-audio-btn").onclick = async () => {
      const btn = contentBox.querySelector("#pdf-audio-btn");
      btn.disabled = true; btn.textContent = "Synthesizing (can take a bit for a whole paper)...";
      try {
        const { audio_url, markers } = await api.getFullAudio(id, voiceSelect.value);
        const audioEl = contentBox.querySelector("#pdf-audio");
        audioEl.src = audio_url;
        audioEl.hidden = false;
        audioEl.play().catch(() => {});
        const jumpSelect = contentBox.querySelector("#pdf-jump-select");
        jumpSelect.innerHTML = `<option value="">Jump to section...</option>` +
          markers.map((m) => `<option value="${m.seconds}">${escapeHtml(m.section_name)}</option>`).join("");
        jumpSelect.hidden = false;
        jumpSelect.onchange = () => { if (jumpSelect.value) audioEl.currentTime = parseFloat(jumpSelect.value); };
      } catch (err) {
        toast("Narration failed: " + err.message, "error");
      }
      btn.disabled = false; btn.textContent = "🔊 Generate full narration";
    };

    api.listHighlights(id).then((highlights) => {
      renderPdf(contentBox.querySelector("#pdf-box"), pdf_url, {
        highlights,
        onCreateHighlight: async (h) => {
          try {
            const { id: highlightId } = await api.createHighlight(id, h);
            return { ...h, id: highlightId };
          } catch (err) {
            toast("Could not save highlight: " + err.message, "error");
            return null;
          }
        },
        onDeleteHighlight: async (highlightId) => {
          try { await api.deleteHighlight(highlightId); }
          catch (err) { toast("Could not delete highlight: " + err.message, "error"); }
        },
      });
    });
  }

  function renderHumanNotesView() {
    contentBox.innerHTML = `
      <h2>✍️ Human Written Notes</h2>
      <p class="muted text-sm">Freeform notes in your own words -- wrap math/physics in <code>$...$</code> or <code>$$...$$</code>
      (e.g. <code>$E=mc^2$</code>), and chemistry the same way using <code>\\ce{...}</code> inside the delimiters
      (e.g. <code>$\\ce{H2O + CO2 -> H2CO3}$</code>). Autosaves as you type.</p>
      <div class="flex gap-1 mt-1">
        <button id="notes-view-edit" class="sm">Edit</button>
        <button id="notes-view-split" class="sm">Split</button>
        <button id="notes-view-preview" class="sm">Preview</button>
        <span id="notes-save-status" class="faint" style="margin-left:auto; align-self:center;"></span>
      </div>
      <div class="human-notes-editor mt-1" id="human-notes-editor">
        <textarea id="human-notes-textarea" placeholder="Write your notes here..."></textarea>
        <div id="human-notes-preview" class="human-notes-preview"></div>
      </div>
    `;
    const editorBox = contentBox.querySelector("#human-notes-editor");
    const textarea = contentBox.querySelector("#human-notes-textarea");
    const previewBox = contentBox.querySelector("#human-notes-preview");
    const statusEl = contentBox.querySelector("#notes-save-status");
    const modeButtons = { edit: contentBox.querySelector("#notes-view-edit"), split: contentBox.querySelector("#notes-view-split"), preview: contentBox.querySelector("#notes-view-preview") };

    function renderPreview() {
      previewBox.innerHTML = mdLiteToHtml(textarea.value);
      renderInlineMath(previewBox);
    }

    function setMode(mode) {
      editorBox.className = `human-notes-editor mt-1 mode-${mode}`;
      for (const [m, btn] of Object.entries(modeButtons)) btn.classList.toggle("active-mode", m === mode);
      if (mode !== "edit") renderPreview();
    }
    modeButtons.edit.onclick = () => setMode("edit");
    modeButtons.split.onclick = () => setMode("split");
    modeButtons.preview.onclick = () => setMode("preview");

    let saveTimer = null;
    textarea.addEventListener("input", () => {
      statusEl.textContent = "Saving...";
      if (editorBox.className.includes("mode-split") || editorBox.className.includes("mode-preview")) renderPreview();
      clearTimeout(saveTimer);
      saveTimer = setTimeout(async () => {
        await api.saveHumanNotes(id, textarea.value);
        statusEl.textContent = "Saved ✓";
      }, 800);
    });

    api.getHumanNotes(id).then(({ content }) => {
      textarea.value = content || "";
      setMode("split");
    });
  }

  function renderAskView() {
    const history = [];
    contentBox.innerHTML = `
      <h2>💬 Ask This Paper</h2>
      <p class="muted text-sm">Every answer is grounded in this paper's own text, not general knowledge --
      for comparing across papers, use Synthesize instead. Your conversation is saved and picks up where
      you left off.${pdf_url ? ' <a href="#" id="ask-view-source">📄 View source</a>' : ""}</p>
      <div class="chat-log" id="chat-log"></div>
      <div class="chat-input-row">
        <textarea id="ask-input" placeholder="Ask a question about this paper..."></textarea>
        <button id="ask-send" class="primary">Send</button>
      </div>
    `;
    const log = contentBox.querySelector("#chat-log");
    const input = contentBox.querySelector("#ask-input");
    const viewSourceLink = contentBox.querySelector("#ask-view-source");
    if (viewSourceLink) viewSourceLink.onclick = (e) => { e.preventDefault(); current = "pdf"; renderToc(); renderContent(); };

    api.getChatHistory(id).then((messages) => {
      for (const m of messages) {
        const bubble = el(`<div class="chat-msg ${m.role}"></div>`);
        bubble.innerHTML = escapeHtml(m.content).replace(/\n/g, "<br>");
        log.appendChild(bubble);
        history.push({ role: m.role, content: m.content });
      }
      log.scrollTop = log.scrollHeight;
    });

    async function send() {
      const q = input.value.trim();
      if (!q) return;
      input.value = "";
      log.appendChild(el(`<div class="chat-msg user">${escapeHtml(q)}</div>`));
      const thinking = el(`<div class="chat-msg assistant"><span class="spinner"></span></div>`);
      log.appendChild(thinking);
      log.scrollTop = log.scrollHeight;
      history.push({ role: "user", content: q });
      try {
        const { answer } = await api.askPaper(id, q, history);
        thinking.innerHTML = escapeHtml(answer).replace(/\n/g, "<br>");
        history.push({ role: "assistant", content: answer });
      } catch (err) {
        thinking.innerHTML = `<span style="color:var(--red);">${err.message}</span>`;
      }
      log.scrollTop = log.scrollHeight;
    }
    contentBox.querySelector("#ask-send").onclick = send;
    input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } });
  }

  renderToc();
  renderContent();
}

/** Small hand-rolled markdown-lite -> HTML converter for the Human Written
 * Notes preview: headings/bold/italic/code/bullets, no library. Escapes HTML
 * first (user-typed content), so $...$ / \ce{...} math delimiters pass
 * through untouched for renderInlineMath (KaTeX) to pick up afterward. */
function mdLiteToHtml(raw) {
  if (!raw || !raw.trim()) return '<span class="muted">Nothing written yet.</span>';
  let html = escapeHtml(raw);
  html = html.replace(/^### (.*)$/gm, "<h4>$1</h4>");
  html = html.replace(/^## (.*)$/gm, "<h3>$1</h3>");
  html = html.replace(/^# (.*)$/gm, "<h2>$1</h2>");
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<em>$1</em>");
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/^- (.*)$/gm, "<li>$1</li>");
  html = html.replace(/(?:<li>.*<\/li>\n?)+/g, (m) => `<ul>${m}</ul>`);
  html = html.replace(/\n/g, "<br>");
  return html;
}

function groupBy(rows, key) {
  const out = {};
  for (const r of rows) (out[r[key]] ||= []).push(r);
  return out;
}

function markdownTableToHtml(md) {
  const lines = md.trim().split("\n").filter(Boolean);
  if (lines.length < 2) return escapeHtml(md);
  const rows = lines.filter((l) => !/^\|[\s|:-]+\|$/.test(l)).map((l) =>
    l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim())
  );
  const [header, ...body] = rows;
  const thead = `<tr>${header.map((h) => `<th>${h}</th>`).join("")}</tr>`;
  const tbody = body.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("");
  return `<table class="paper-table"><thead>${thead}</thead><tbody>${tbody}</tbody></table>`;
}
