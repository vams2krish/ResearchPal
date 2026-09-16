export function toast(message, type = "") {
  const root = document.getElementById("toast-root");
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

export function showModal(innerHtml, { onMount } = {}) {
  const root = document.getElementById("modal-root");
  root.innerHTML = `<div class="modal-backdrop"><div class="modal-box">${innerHtml}</div></div>`;
  const backdrop = root.querySelector(".modal-backdrop");
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) closeModal(); });
  document.addEventListener("keydown", escHandler);
  if (onMount) onMount(root.querySelector(".modal-box"));
  return root.querySelector(".modal-box");
}

function escHandler(e) {
  if (e.key === "Escape") closeModal();
}

export function closeModal() {
  document.getElementById("modal-root").innerHTML = "";
  document.removeEventListener("keydown", escHandler);
}

export function confirmDialog(message, onConfirm, confirmLabel = "Delete") {
  showModal(`
    <div class="modal-head"><h3>Are you sure?</h3></div>
    <p class="muted">${escapeHtml(message)}</p>
    <div class="flex gap-2" style="justify-content:flex-end;">
      <button id="confirm-cancel">Cancel</button>
      <button id="confirm-ok" class="danger">${confirmLabel}</button>
    </div>
  `, {
    onMount: (box) => {
      box.querySelector("#confirm-cancel").onclick = closeModal;
      box.querySelector("#confirm-ok").onclick = () => { closeModal(); onConfirm(); };
    },
  });
}

export function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s ?? "";
  return div.innerHTML;
}

export function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export function timeAgo(isoString) {
  if (!isoString) return "";
  const diff = (Date.now() - new Date(isoString).getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}
