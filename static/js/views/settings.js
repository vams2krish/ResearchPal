import { api } from "../api.js";
import { toast, escapeHtml } from "../ui.js";

/** Works in both the plain browser and the Electron desktop shell.
 * `window.electronAPI` (injected by desktop/preload.js) is the only signal
 * that native folder pickers / an in-app backend restart are available --
 * absent it, this degrades to a plain form that writes the same .env values
 * server-side and asks for a manual restart. */
export async function renderSettings() {
  const root = document.getElementById("view-root");
  const isDesktop = typeof window.electronAPI !== "undefined";
  root.innerHTML = `<div class="muted">Loading...</div>`;

  const [settings, ollamaModels] = await Promise.all([
    api.getSettings(),
    api.listOllamaModels().catch(() => []),
  ]);

  root.innerHTML = `
    <div class="page-title">⚙️ Settings</div>
    <p class="muted mt-1">${isDesktop ? "Running in the desktop app." : "Running in a browser."}
    Changes are saved to the backend's <code>.env</code> file and take effect after a restart.</p>

    <div class="card mt-2">
      <h3>Language model</h3>
      <div class="flex gap-2 items-center mt-1" style="flex-wrap:wrap;">
        <label class="text-sm muted" style="width:140px;">Primary backend</label>
        <select id="primary-llm" class="sm">
          <option value="gemini">Gemini (cloud, needs API key)</option>
          <option value="ollama">Ollama (local)</option>
        </select>
      </div>
      <div class="flex gap-2 items-center mt-1" style="flex-wrap:wrap;">
        <label class="text-sm muted" style="width:140px;">Ollama host</label>
        <input id="ollama-host" type="text" style="flex:1; min-width:200px;">
      </div>
      <div class="flex gap-2 items-center mt-1" style="flex-wrap:wrap;">
        <label class="text-sm muted" style="width:140px;">Ollama model</label>
        <select id="ollama-model" class="sm" style="flex:1; min-width:200px;">
          ${ollamaModels.map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join("")}
        </select>
        <button id="detect-models-btn" class="sm ghost-btn">Detect models</button>
      </div>
      <p class="faint mt-1">${ollamaModels.length ? `${ollamaModels.length} model(s) found locally.` : "No local Ollama models detected -- is `ollama serve` running?"}</p>
      <div class="flex gap-2 items-center mt-2" style="flex-wrap:wrap;">
        <label class="text-sm muted" style="width:140px;">Gemini API key</label>
        <input id="gemini-key" type="password" autocomplete="off" style="flex:1; min-width:200px;"
          placeholder="${settings.has_gemini_key ? "•••••••••••• (set -- leave blank to keep it)" : "Paste your key from aistudio.google.com/apikey"}">
      </div>
      <p class="faint mt-1">${settings.has_gemini_key
        ? "A key is already set. This field is intentionally left blank -- it's never sent back to the browser. Type a new key here only to replace it."
        : `<span style="color:var(--orange);">No key set -- Gemini calls will fail until one is added.</span> Get a free one at aistudio.google.com/apikey.`}</p>
    </div>

    <div class="card mt-2">
      <h3>Storage</h3>
      <div class="flex gap-2 items-center mt-1" style="flex-wrap:wrap;">
        <label class="text-sm muted" style="width:140px;">Data folder</label>
        <input id="data-dir" type="text" style="flex:1; min-width:260px;" ${isDesktop ? "readonly" : ""}>
        ${isDesktop ? `<button id="pick-folder-btn" class="sm">Choose folder…</button>` : ""}
      </div>
      <p class="faint mt-1">Papers, the database, and cached audio all live under this folder.
      ${isDesktop ? "" : "Editing this only makes sense if the new path already exists and is readable by the server process."}</p>
    </div>

    <div class="flex gap-2 mt-2">
      <button id="save-settings-btn" class="primary">Save</button>
      ${isDesktop ? `<button id="restart-backend-btn" class="sm ghost-btn">Restart backend now</button>` : ""}
    </div>
  `;

  root.querySelector("#primary-llm").value = settings.primary_llm;
  root.querySelector("#ollama-host").value = settings.ollama_host;
  root.querySelector("#data-dir").value = settings.data_dir;
  const modelSelect = root.querySelector("#ollama-model");
  if (![...modelSelect.options].some((o) => o.value === settings.ollama_model)) {
    modelSelect.insertAdjacentHTML("afterbegin", `<option value="${escapeHtml(settings.ollama_model)}">${escapeHtml(settings.ollama_model)} (current)</option>`);
  }
  modelSelect.value = settings.ollama_model;

  root.querySelector("#detect-models-btn").onclick = async () => {
    const models = await api.listOllamaModels().catch(() => []);
    if (!models.length) { toast("No Ollama models found -- is `ollama serve` running?", "error"); return; }
    modelSelect.innerHTML = models.map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join("");
    toast(`Found ${models.length} model(s).`, "success");
  };

  if (isDesktop) {
    root.querySelector("#pick-folder-btn").onclick = async () => {
      const folder = await window.electronAPI.pickFolder();
      if (folder) root.querySelector("#data-dir").value = folder;
    };
    root.querySelector("#restart-backend-btn").onclick = async () => {
      toast("Restarting backend...");
      await window.electronAPI.restartBackend();
      toast("Backend restarted.", "success");
    };
  }

  root.querySelector("#save-settings-btn").onclick = async () => {
    const geminiKey = root.querySelector("#gemini-key").value.trim();
    await api.saveSettings({
      primary_llm: root.querySelector("#primary-llm").value,
      ollama_host: root.querySelector("#ollama-host").value,
      ollama_model: modelSelect.value,
      data_dir: root.querySelector("#data-dir").value,
      ...(geminiKey ? { gemini_api_key: geminiKey } : {}),
    });
    root.querySelector("#gemini-key").value = "";
    toast(isDesktop ? "Saved -- use \"Restart backend now\" to apply." : "Saved -- restart the server to apply.", "success");
  };
}
