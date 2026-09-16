import { api } from "./api.js";
import { route, startRouter, navigate } from "./router.js";
import { renderLibrary } from "./views/library.js";
import { renderPaper } from "./views/paper.js";
import { renderReview } from "./views/review.js";
import { renderSynthesize } from "./views/synthesize.js";
import { renderDashboard } from "./views/dashboard.js";
import { renderGlossary } from "./views/glossary.js";
import { renderSearch } from "./views/search.js";
import { renderCompare } from "./views/compare.js";
import { renderConcepts } from "./views/concepts.js";
import { renderModels } from "./views/models.js";
import { renderResearch } from "./views/research.js";
import { renderSettings } from "./views/settings.js";
import "./sidebar.js";

// Clicking a sidebar nav link leaves it focused; pressing Space afterward
// (e.g. to reveal a flashcard answer) then re-activates that focused link
// as a native click instead of reaching a view's own keydown handler.
// Blur it right after navigating so Space/1-4 always reach the view.
document.querySelectorAll(".nav-link").forEach((a) => {
  a.addEventListener("click", () => setTimeout(() => a.blur(), 0));
});

route("/library", renderLibrary);
route("/paper/:id", renderPaper);
route("/review", renderReview);
route("/synthesize", renderSynthesize);
route("/dashboard", renderDashboard);
route("/glossary", renderGlossary);
route("/search", renderSearch);
route("/compare", renderCompare);
route("/concepts", renderConcepts);
route("/models", renderModels);
route("/research", renderResearch);
route("/settings", renderSettings);

// ------------------------------------------------------------------ Theme
const THEME_KEY = "oce-theme";
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.getElementById("theme-toggle").textContent = theme === "dark" ? "🌙 Dark" : "☀️ Light";
  localStorage.setItem(THEME_KEY, theme);
}
applyTheme(localStorage.getItem(THEME_KEY) || "dark");
document.getElementById("theme-toggle").onclick = () => {
  applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
};

// ----------------------------------------------------------------- Search
const searchInput = document.getElementById("global-search");
searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && searchInput.value.trim()) {
    navigate(`/search?q=${encodeURIComponent(searchInput.value.trim())}`);
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "/" && document.activeElement !== searchInput && !["TEXTAREA", "INPUT"].includes(document.activeElement.tagName)) {
    e.preventDefault();
    searchInput.focus();
  }
});

// ------------------------------------------------------------- Due badge
async function refreshDueBadge() {
  try {
    const due = await api.dueFlashcards(1000);
    const badge = document.getElementById("due-badge");
    if (due.length) { badge.hidden = false; badge.textContent = due.length; }
    else badge.hidden = true;
  } catch { /* offline or backend still starting */ }
}
refreshDueBadge();
setInterval(refreshDueBadge, 60_000);

// ------------------------------------------------------------ LLM status
async function refreshStatus() {
  try {
    const s = await api.status();
    document.getElementById("llm-status").textContent =
      `${s.primary_llm}${s.last_backend ? ` (last: ${s.last_backend})` : ""}`;
  } catch { /* ignore */ }
}
refreshStatus();
setInterval(refreshStatus, 30_000);

// --------------------------------------------------------- PWA (iOS/Android)
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => { /* offline shell just won't be available */ });
}

startRouter();
