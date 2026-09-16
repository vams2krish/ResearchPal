import { api } from "../api.js";
import { escapeHtml, timeAgo } from "../ui.js";
import { navigate } from "../router.js";

const ACTIVITY_ICON = {
  paper_uploaded: "📤", paper_processed: "✅", note_added: "📝", highlight_added: "🖍",
  tag_added: "🏷️", mental_model_tagged: "🧭", research_session_created: "🔭", paper_favorited: "⭐",
};

export async function renderDashboard() {
  const root = document.getElementById("view-root");
  const [stats, activity] = await Promise.all([api.dashboard(), api.getActivity(20)]);

  const maxReviews = Math.max(1, ...stats.reviews_by_day.map((d) => d.n));
  const days = [...stats.reviews_by_day].reverse();

  root.innerHTML = `
    <div class="page-title">📊 Dashboard</div>
    <div class="stat-grid mt-2">
      <div class="card stat-card"><div class="stat-num">${stats.total_papers}</div><div class="stat-label">Papers</div></div>
      <div class="card stat-card"><div class="stat-num">${stats.processed}</div><div class="stat-label">Processed</div></div>
      <div class="card stat-card"><div class="stat-num">${stats.total_cards}</div><div class="stat-label">Flashcards</div></div>
      <div class="card stat-card"><div class="stat-num">${stats.reviews_done}</div><div class="stat-label">Reviews done</div></div>
      <div class="card stat-card"><div class="stat-num">${stats.total_claims}</div><div class="stat-label">Claims extracted</div></div>
      <div class="card stat-card"><div class="stat-num">${stats.total_equations}</div><div class="stat-label">Formulas explained</div></div>
    </div>

    <div class="card mt-2">
      <h3>Reviews, last 14 days</h3>
      ${days.length ? `<div class="bar-chart mt-2">
        ${days.map((d) => `<div class="bar" style="height:${Math.max(4, (d.n / maxReviews) * 90)}px" title="${d.day}: ${d.n}"></div>`).join("")}
      </div>` : `<p class="muted text-sm">No reviews logged yet.</p>`}
    </div>

    <div class="card mt-2">
      <h3>Recently added</h3>
      <div id="recent-list"></div>
    </div>

    <div class="card mt-2">
      <h3>Recent activity</h3>
      <div id="activity-list"></div>
    </div>
  `;

  const list = root.querySelector("#recent-list");
  for (const p of stats.recent) {
    const row = document.createElement("div");
    row.className = "flex justify-between items-center";
    row.style.cssText = "padding:8px 0; border-bottom:1px solid var(--border); cursor:pointer;";
    row.innerHTML = `<span>${escapeHtml(p.title)}</span><span class="faint">${timeAgo(p.added_at)}</span>`;
    row.onclick = () => navigate(`/paper/${p.id}`);
    list.appendChild(row);
  }

  const activityList = root.querySelector("#activity-list");
  if (!activity.length) {
    activityList.innerHTML = `<p class="muted text-sm">No activity yet -- upload a paper to get started.</p>`;
  }
  for (const a of activity) {
    const row = document.createElement("div");
    row.className = "flex items-center gap-2";
    row.style.cssText = `padding:7px 0; border-bottom:1px solid var(--border);${a.paper_id ? " cursor:pointer;" : ""}`;
    row.innerHTML = `<span>${ACTIVITY_ICON[a.event_type] || "•"}</span><span style="flex:1;">${escapeHtml(a.description)}</span><span class="faint">${timeAgo(a.created_at)}</span>`;
    if (a.paper_id) row.onclick = () => navigate(`/paper/${a.paper_id}`);
    activityList.appendChild(row);
  }
}
