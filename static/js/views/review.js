import { api } from "../api.js";
import { el, escapeHtml } from "../ui.js";

const RATE_BUTTONS = [
  { rating: 1, label: "🔴 Again", cls: "rate-again", key: "1" },
  { rating: 2, label: "🟠 Hard", cls: "rate-hard", key: "2" },
  { rating: 3, label: "🟢 Good", cls: "rate-good", key: "3" },
  { rating: 4, label: "🔵 Easy", cls: "rate-easy", key: "4" },
];

export async function renderReview() {
  const root = document.getElementById("view-root");
  root.innerHTML = `<div class="page-title">🧠 Spaced-repetition review</div><div id="review-box" class="mt-2"></div>`;
  const box = root.querySelector("#review-box");

  let due = await api.dueFlashcards(20);
  let keyHandler = null;

  function cleanup() {
    if (keyHandler) document.removeEventListener("keydown", keyHandler);
  }

  function draw() {
    cleanup();
    if (!due.length) {
      box.innerHTML = `<div class="empty-state"><div class="icon">🎉</div><p>Nothing due right now. Come back later, or add more papers.</p></div>`;
      return;
    }
    const card = due[0];
    box.innerHTML = `
      <div class="review-card">
        <div class="progress-track"><div class="progress-fill" style="width:${100 / (due.length + 1)}%"></div></div>
        <div class="faint mt-1">${due.length} card(s) due</div>
        <div class="card mt-2">
          <span class="badge-pill blue">${card.card_type}</span>
          <div class="faint mt-1">from <em>${escapeHtml(card.paper_title)}</em></div>
          <div class="review-front">${escapeHtml(card.front)}</div>
          <div id="answer-area"></div>
        </div>
      </div>
    `;
    const answerArea = box.querySelector("#answer-area");
    const showBtn = el(`<button class="block">👁️ Show answer <span class="kbd">Space</span></button>`);
    answerArea.appendChild(showBtn);

    function reveal() {
      showBtn.blur();
      answerArea.innerHTML = `
        <div class="review-back">${escapeHtml(card.back)}</div>
        <div class="faint mb-1">How well did you know this?</div>
        <div class="rate-row" id="rate-row"></div>
      `;
      const row = answerArea.querySelector("#rate-row");
      for (const b of RATE_BUTTONS) {
        const btn = el(`<button class="${b.cls}">${b.label} <span class="kbd">${b.key}</span></button>`);
        btn.onclick = () => rate(b.rating);
        row.appendChild(btn);
      }
    }
    showBtn.onclick = reveal;

    async function rate(rating) {
      await api.reviewFlashcard(card.id, rating);
      due.shift();
      draw();
    }

    keyHandler = (e) => {
      if (e.target.tagName === "TEXTAREA" || e.target.tagName === "INPUT") return;
      if (e.code === "Space" && !answerArea.querySelector("#rate-row")) { e.preventDefault(); reveal(); }
      const b = RATE_BUTTONS.find((x) => x.key === e.key);
      if (b && answerArea.querySelector("#rate-row")) rate(b.rating);
    };
    document.addEventListener("keydown", keyHandler);
  }

  draw();
  return cleanup;
}
