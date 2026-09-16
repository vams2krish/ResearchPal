// Sidebar collapse (desktop, icon-only rail) / open-close (mobile, off-canvas
// drawer) -- same toggle button, two behaviors depending on viewport width,
// both animated purely via CSS transitions (see .sidebar rules in style.css).

const COLLAPSE_KEY = "oce-sidebar-collapsed";
const MOBILE_QUERY = window.matchMedia("(max-width: 860px)");

const sidebar = document.getElementById("sidebar");
const toggleBtn = document.getElementById("sidebar-toggle");
const hamburgerBtn = document.getElementById("sidebar-hamburger");
const backdrop = document.getElementById("sidebar-backdrop");

function isMobile() {
  return MOBILE_QUERY.matches;
}

function updateToggleIcon() {
  if (isMobile()) {
    toggleBtn.textContent = "✕";
    toggleBtn.title = "Close menu";
  } else {
    const collapsed = sidebar.classList.contains("collapsed");
    toggleBtn.textContent = collapsed ? "▶" : "◀";
    toggleBtn.title = collapsed ? "Expand menu" : "Collapse menu";
  }
}

function openMobile() {
  sidebar.classList.add("open");
  backdrop.classList.add("show");
  updateToggleIcon();
}

function closeMobile() {
  sidebar.classList.remove("open");
  backdrop.classList.remove("show");
}

function setCollapsed(collapsed) {
  sidebar.classList.toggle("collapsed", collapsed);
  localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0");
  updateToggleIcon();
}

setCollapsed(localStorage.getItem(COLLAPSE_KEY) === "1");

toggleBtn.addEventListener("click", () => {
  if (isMobile()) closeMobile();
  else setCollapsed(!sidebar.classList.contains("collapsed"));
});

hamburgerBtn.addEventListener("click", () => {
  if (sidebar.classList.contains("open")) closeMobile();
  else openMobile();
});

backdrop.addEventListener("click", closeMobile);

sidebar.querySelectorAll(".nav-link").forEach((a) => {
  a.addEventListener("click", () => { if (isMobile()) closeMobile(); });
});

MOBILE_QUERY.addEventListener("change", () => {
  closeMobile();
  sidebar.classList.remove("collapsed");
  if (!isMobile()) setCollapsed(localStorage.getItem(COLLAPSE_KEY) === "1");
  else updateToggleIcon();
});
