const routes = [];
let currentCleanup = null;
let renderToken = 0;

export function route(pattern, handler) {
  // pattern like "/paper/:id" -> regex with named groups
  const paramNames = [];
  const regexStr = pattern.replace(/:[a-zA-Z]+/g, (m) => {
    paramNames.push(m.slice(1));
    return "([^/]+)";
  });
  routes.push({ regex: new RegExp(`^${regexStr}$`), paramNames, handler });
}

export function navigate(path) {
  location.hash = "#" + path;
}

function currentPath() {
  const hash = location.hash.slice(1) || "/library";
  return hash;
}

export function parseQuery(path) {
  const [, qs] = path.split("?");
  return Object.fromEntries(new URLSearchParams(qs || ""));
}

async function resolve() {
  // Captured before any await: if a newer hashchange fires while this
  // handler's async work (a fetch, usually) is still in flight, renderToken
  // moves on and we can tell our own render finished stale below -- two
  // routes navigated in quick succession otherwise race to write
  // #view-root, and whichever's async work happens to resolve *last* wins
  // the content even if its own navigation happened *first* (the nav-link
  // highlight, which updates synchronously up front, would then disagree
  // with what's actually on screen).
  const myToken = ++renderToken;
  const full = currentPath();
  const path = full.split("?")[0];
  for (const r of routes) {
    const m = path.match(r.regex);
    if (m) {
      const params = {};
      r.paramNames.forEach((name, i) => { params[name] = m[i + 1]; });
      params._query = parseQuery(full);
      document.querySelectorAll(".nav-link").forEach((a) => {
        a.classList.toggle("active", full.startsWith("/" + a.dataset.route));
      });
      window.scrollTo(0, 0);
      const root = document.getElementById("view-root");
      root.scrollTop = 0;
      if (currentCleanup) { try { currentCleanup(); } catch { /* ignore */ } currentCleanup = null; }
      try {
        currentCleanup = (await r.handler(params)) || null;
      } catch (err) {
        console.error(err);
        root.innerHTML = `<div class="empty-state"><div class="icon">⚠️</div><p>${err.message}</p></div>`;
      }
      if (myToken !== renderToken) { resolve(); return; } // superseded -- re-resolve to the now-current route instead of trusting this stale render
      return;
    }
  }
  navigate("/library");
}

export function startRouter() {
  window.addEventListener("hashchange", resolve);
  resolve();
}
