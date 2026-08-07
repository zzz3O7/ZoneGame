// ADDED: tiny status-banner helper — connection/match state notices
// (disconnect countdowns, reconnect progress, opponent left, forfeit, etc).
// One shared DOM element (see index.html #netBanner), content swapped in
// and out rather than creating new elements each call. Deliberately dumb —
// callers that need a live countdown (main.js) just call showBanner again
// on their own interval with updated text, rather than this module owning
// timer state too.

export function showBanner(text, { kind = "info", actions = [] } = {}) {
  const el = document.getElementById("netBanner");
  const textEl = document.getElementById("netBannerText");
  const actionsEl = document.getElementById("netBannerActions");
  if (!el || !textEl || !actionsEl) return;

  el.classList.remove("net-banner--warning", "net-banner--danger", "net-banner--info");
  el.classList.add(`net-banner--${kind}`);
  textEl.textContent = text;

  actionsEl.innerHTML = "";
  for (const action of actions) {
    const btn = document.createElement("button");
    btn.className = `btn btn--${action.style ?? "ghost"}`;
    btn.textContent = action.label;
    btn.addEventListener("click", action.onClick);
    actionsEl.appendChild(btn);
  }

  el.hidden = false;
}

export function hideBanner() {
  const el = document.getElementById("netBanner");
  if (el) el.hidden = true;
}
