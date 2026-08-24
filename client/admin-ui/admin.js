// Admin dashboard — plain ES module, no build step, talks to the
// /admin/* API added in adminRoutes.js. Same origin as that API (this
// page is served by the same server via staticServer.js), so no CORS
// setup was needed.

const TOKEN_KEY = "zonegame_admin_token";
const REFRESH_MS = 5000;
// Views that re-fetch on the auto-refresh timer. Players/Games/Bots are
// left out on purpose — they're paginated/filtered, and silently
// resetting someone's scroll position or filters every 5s would be
// actively annoying rather than useful.
const LIVE_VIEWS = new Set(["status", "matches", "connections", "queue", "logs"]);

const els = {
  nav: document.getElementById("nav"),
  content: document.getElementById("content"),
  viewTitle: document.getElementById("viewTitle"),
  viewMeta: document.getElementById("viewMeta"),
  tokenInput: document.getElementById("tokenInput"),
  autoRefreshToggle: document.getElementById("autoRefreshToggle"),
  pulseDot: document.getElementById("pulseDot"),
  pulseLabel: document.getElementById("pulseLabel"),
};

const state = {
  view: "status",
  refreshTimer: null,
  // Per-view UI state that should survive a tab switch but not a reload.
  players: { search: "", isBot: "", sort: "created_at", dir: "desc", offset: 0, expandedId: null },
  games: { player: "", matchType: "", origin: "", offset: 0, expandedId: null },
  matches: { expandedId: null },
  bots: { expandedId: null },
};

// ---------------------------------------------------------------- api --

function getToken() {
  return localStorage.getItem(TOKEN_KEY) || "";
}

async function api(path, { method = "GET", body } = {}) {
  const token = getToken();
  let res;
  try {
    res = await fetch(`/admin${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    setPulse("error", "offline");
    throw new Error(`Network error: ${err.message}`);
  }

  if (res.status === 401) {
    setPulse("error", "unauthorized");
    throw new Error("Unauthorized — check the admin token in the sidebar.");
  }
  if (res.status === 503) {
    setPulse("error", "not configured");
    throw new Error("Admin API not configured on the server (ADMIN_TOKEN unset).");
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    /* no body */
  }

  if (!res.ok) {
    setPulse("error", `HTTP ${res.status}`);
    throw new Error(data?.error || `Request failed (${res.status})`);
  }

  setPulse("live", "connected");
  return data;
}

function setPulse(kind, label) {
  els.pulseDot.className = `pulse ${kind === "live" ? "is-live" : kind === "error" ? "is-error" : ""}`;
  els.pulseLabel.textContent = label;
}

// ------------------------------------------------------------ helpers --

function esc(str) {
  return String(str ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

function relTime(ms) {
  if (ms == null) return "—";
  const diff = Date.now() - ms;
  const abs = Math.abs(diff);
  const s = Math.round(abs / 1000);
  let out;
  if (s < 60) out = `${s}s`;
  else if (s < 3600) out = `${Math.round(s / 60)}m`;
  else if (s < 86400) out = `${Math.round(s / 3600)}h`;
  else out = `${Math.round(s / 86400)}d`;
  return diff >= 0 ? `${out} ago` : `in ${out}`;
}

function fmtDate(ms) {
  if (ms == null) return "—";
  return new Date(ms).toLocaleString();
}

function fmtDuration(ms) {
  if (ms == null) return "—";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}

function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

function showToast(message, isError = false) {
  const t = el(`<div class="toast${isError ? " toast--error" : ""}">${esc(message)}</div>`);
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3200);
}

function errorBanner(err) {
  return `<div class="error-banner">${esc(err.message)}</div>`;
}

// -------------------------------------------------------------- router --

function setView(view) {
  state.view = view;
  [...els.nav.children].forEach((btn) => btn.classList.toggle("active", btn.dataset.view === view));
  els.viewTitle.textContent = view[0].toUpperCase() + view.slice(1);
  render();
  restartAutoRefresh();
}

els.nav.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-view]");
  if (btn) setView(btn.dataset.view);
});

async function render() {
  const renderers = {
    status: renderStatus,
    matches: renderMatches,
    connections: renderConnections,
    queue: renderQueue,
    players: renderPlayers,
    games: renderGames,
    bots: renderBots,
    logs: renderLogs,
  };
  try {
    await renderers[state.view]();
  } catch (err) {
    els.content.innerHTML = errorBanner(err);
  }
}

function restartAutoRefresh() {
  clearInterval(state.refreshTimer);
  if (!els.autoRefreshToggle.checked) return;
  state.refreshTimer = setInterval(() => {
    if (LIVE_VIEWS.has(state.view)) render();
  }, REFRESH_MS);
}

els.autoRefreshToggle.addEventListener("change", restartAutoRefresh);

els.tokenInput.value = getToken();
els.tokenInput.addEventListener("change", () => {
  localStorage.setItem(TOKEN_KEY, els.tokenInput.value.trim());
  render();
});

// -------------------------------------------------------------- status --

async function renderStatus() {
  const [status, metrics, version] = await Promise.all([api("/status"), api("/metrics"), api("/version")]);
  els.viewMeta.textContent = `updated ${new Date().toLocaleTimeString()}`;

  const byStatus =
    Object.entries(status.matches.byStatus)
      .map(([k, v]) => `${k}: ${v}`)
      .join(" · ") || "none";

  const queueTotal = (pool) => pool.any.length + Object.values(pool.specific).reduce((a, l) => a + l.length, 0);

  els.content.innerHTML = `
    <div class="card-grid">
      <div class="card">
        <div class="card__label">Uptime</div>
        <div class="card__value">${fmtDuration(status.uptimeSec * 1000)}</div>
      </div>
      <div class="card">
        <div class="card__label">Connections</div>
        <div class="card__value">${status.connections}</div>
      </div>
      <div class="card">
        <div class="card__label">Live matches</div>
        <div class="card__value">${status.matches.total}</div>
        <div class="card__sub">${esc(byStatus)}</div>
      </div>
      <div class="card">
        <div class="card__label">In queue</div>
        <div class="card__value">${queueTotal(status.queue.rated) + queueTotal(status.queue.unrated)}</div>
        <div class="card__sub">rated ${queueTotal(status.queue.rated)} · unrated ${queueTotal(status.queue.unrated)}</div>
      </div>
      <div class="card">
        <div class="card__label">Memory (RSS)</div>
        <div class="card__value">${metrics.memory.rssMb} MB</div>
        <div class="card__sub">heap ${metrics.memory.heapUsedMb}/${metrics.memory.heapTotalMb} MB</div>
      </div>
      <div class="card">
        <div class="card__label">Event loop lag</div>
        <div class="card__value">${metrics.eventLoopLagMs} ms</div>
        <div class="card__sub">${metrics.wsMessagesPerMinute} ws msgs/min</div>
      </div>
      <div class="card">
        <div class="card__label">Running commit</div>
        <div class="card__value" style="font-size:16px">${esc(version.gitCommit ?? "unknown")}</div>
        <div class="card__sub">${
          version.gitError
            ? `<span style="color:var(--color-danger)">${esc(version.gitError)}</span>`
            : `${esc(version.gitBranch ?? "?")}${version.gitDirty ? " · dirty" : ""} · node ${esc(version.nodeVersion)}`
        }</div>
      </div>
    </div>
  `;
}

// ------------------------------------------------------------- matches --

function matchStatusPill(status) {
  const cls = status === "active" ? "pill--live" : status === "aborted" ? "pill--danger" : "";
  return `<span class="pill ${cls}">${esc(status)}</span>`;
}

async function renderMatches() {
  const { matches } = await api("/matches");
  els.viewMeta.textContent = `${matches.length} live`;

  if (!matches.length) {
    els.content.innerHTML = `<div class="empty-state">No live matches right now.</div>`;
    return;
  }

  const rows = matches
    .map(
      (m) => `
      <tr class="is-clickable" data-id="${esc(m.matchId)}">
        <td class="mono">${esc(m.matchId.slice(0, 8))}</td>
        <td>${matchStatusPill(m.status)}</td>
        <td>${esc(m.matchType)}${m.rated ? "" : ' <span class="muted">(unrated)</span>'}</td>
        <td>${m.players.map((p) => esc(p.nickname ?? "guest")).join(" vs ")}</td>
        <td class="mono muted">${relTime(m.startedAt)}</td>
      </tr>`,
    )
    .join("");

  els.content.innerHTML = `
    <table>
      <thead><tr><th>ID</th><th>Status</th><th>Type</th><th>Players</th><th>Started</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div id="matchDetail"></div>
  `;

  els.content.querySelectorAll("tr[data-id]").forEach((tr) => {
    tr.addEventListener("click", () => toggleMatchDetail(tr.dataset.id));
  });

  if (state.matches.expandedId && matches.some((m) => m.matchId === state.matches.expandedId)) {
    await showMatchDetail(state.matches.expandedId);
  }
}

async function toggleMatchDetail(id) {
  state.matches.expandedId = state.matches.expandedId === id ? null : id;
  document.getElementById("matchDetail").innerHTML = "";
  if (state.matches.expandedId) await showMatchDetail(id);
}

async function showMatchDetail(id) {
  const { match } = await api(`/matches/${id}`);
  const scores = match.game ? match.game.scores.join(" – ") : "—";
  document.getElementById("matchDetail").innerHTML = `
    <div class="detail-panel">
      <h3>Match ${esc(match.matchId.slice(0, 8))}</h3>
      <div class="kv-grid">
        <div><div class="k">Origin</div><div class="v">${esc(match.origin)}</div></div>
        <div><div class="k">Actions</div><div class="v">${match.actionCount}</div></div>
        <div><div class="k">Score</div><div class="v">${esc(scores)}</div></div>
        <div><div class="k">Current turn</div><div class="v">${match.game ? `P${match.game.currentPlayerIndex}` : "—"}</div></div>
        <div><div class="k">Board points</div><div class="v">${match.game?.totalBoardPoints ?? "—"}</div></div>
        <div><div class="k">Invite code</div><div class="v">${esc(match.inviteCode ?? "—")}</div></div>
      </div>
      <div class="section-title" style="margin-top:0">Players</div>
      <table>
        <thead><tr><th>#</th><th>Nickname</th><th>Account ID</th><th>Connected</th><th>Session</th></tr></thead>
        <tbody>
          ${match.players
            .map(
              (p) => `<tr>
                <td>${p.playerIndex}</td>
                <td>${esc(p.nickname ?? "guest")}</td>
                <td class="mono">${p.accountPlayerId ?? "—"}</td>
                <td>${p.connected ? '<span class="pill pill--live">yes</span>' : '<span class="pill pill--danger">no</span>'}</td>
                <td class="mono muted">${esc(p.sessionId ?? "—")}</td>
              </tr>`,
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

// --------------------------------------------------------- connections --

async function renderConnections() {
  const { connections } = await api("/connections");
  els.viewMeta.textContent = `${connections.length} open`;

  if (!connections.length) {
    els.content.innerHTML = `<div class="empty-state">No open connections.</div>`;
    return;
  }

  const rows = connections
    .map(
      (c) => `
      <tr>
        <td>${esc(c.nickname ?? "guest")}</td>
        <td class="mono">${esc(c.ip ?? "—")}</td>
        <td class="mono muted">${relTime(c.connectedAt)}</td>
        <td>${c.isAlive ? '<span class="pill pill--live">alive</span>' : '<span class="pill pill--danger">stale</span>'}</td>
        <td class="mono">${c.inMatchId ? esc(c.inMatchId.slice(0, 8)) : '<span class="muted">—</span>'}</td>
      </tr>`,
    )
    .join("");

  els.content.innerHTML = `
    <table>
      <thead><tr><th>Player</th><th>IP</th><th>Connected</th><th>Heartbeat</th><th>In match</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

// ---------------------------------------------------------------- queue --

function queuePoolHtml(title, pool) {
  const modeRows = Object.entries(pool.specific)
    .map(([mode, entries]) => `<tr><td>${esc(mode)}</td><td class="num">${entries.length}</td></tr>`)
    .join("");
  const entries = [...pool.any, ...Object.values(pool.specific).flat()];
  const entryRows = entries
    .map(
      (e) => `<tr>
        <td>${esc(e.nickname ?? "guest")}</td>
        <td class="num">${Math.round(e.mu)} ± ${Math.round(e.sigma)}</td>
        <td class="mono muted">${fmtDuration(e.waitedMs)}</td>
      </tr>`,
    )
    .join("");

  return `
    <div class="section-title">${esc(title)}</div>
    <table style="margin-bottom:14px">
      <thead><tr><th>Time mode</th><th>Waiting</th></tr></thead>
      <tbody>
        <tr><td>any</td><td class="num">${pool.any.length}</td></tr>
        ${modeRows}
      </tbody>
    </table>
    ${
      entries.length
        ? `<table>
            <thead><tr><th>Player</th><th>Rating</th><th>Waited</th></tr></thead>
            <tbody>${entryRows}</tbody>
          </table>`
        : `<div class="empty-state">Nobody waiting.</div>`
    }
  `;
}

async function renderQueue() {
  const q = await api("/queue");
  els.viewMeta.textContent = "";
  els.content.innerHTML = queuePoolHtml("Rated", q.rated) + queuePoolHtml("Unrated", q.unrated);
}

// -------------------------------------------------------------- players --

async function renderPlayers() {
  const s = state.players;
  const params = new URLSearchParams({
    sort: s.sort,
    dir: s.dir,
    limit: "50",
    offset: String(s.offset),
    ...(s.search ? { search: s.search } : {}),
    ...(s.isBot ? { isBot: s.isBot } : {}),
  });
  const { rows, total } = await api(`/players?${params}`);
  els.viewMeta.textContent = `${total} total`;

  const sortHeader = (col, label) =>
    `<th class="sortable" data-sort="${col}">${label}${s.sort === col ? (s.dir === "asc" ? " ↑" : " ↓") : ""}</th>`;

  const tableRows = rows
    .map(
      (p) => `
      <tr class="is-clickable" data-id="${p.id}">
        <td>${esc(p.nickname)}</td>
        <td class="num">${Math.round(p.rating_mu)} ± ${Math.round(p.rating_sigma)}</td>
        <td class="mono">${p.games_played}</td>
        <td>${p.is_bot ? '<span class="pill">bot</span>' : "human"}</td>
        <td class="mono muted">${fmtDate(p.created_at)}</td>
      </tr>`,
    )
    .join("");

  els.content.innerHTML = `
    <div class="toolbar">
      <input type="text" id="playerSearch" placeholder="search nickname/email…" value="${esc(s.search)}" />
      <select id="playerBotFilter">
        <option value="" ${s.isBot === "" ? "selected" : ""}>All players</option>
        <option value="false" ${s.isBot === "false" ? "selected" : ""}>Humans only</option>
        <option value="true" ${s.isBot === "true" ? "selected" : ""}>Bots only</option>
      </select>
    </div>
    ${
      rows.length
        ? `<table>
            <thead><tr>${sortHeader("nickname", "Nickname")}${sortHeader("rating_mu", "Rating")}${sortHeader("games_played", "Games")}<th>Type</th>${sortHeader("created_at", "Joined")}</tr></thead>
            <tbody>${tableRows}</tbody>
          </table>`
        : `<div class="empty-state">No players match this filter.</div>`
    }
    <div class="pagination">
      <button class="btn" id="playersPrev" ${s.offset === 0 ? "disabled" : ""}>← Prev</button>
      <span>${s.offset + 1}–${Math.min(s.offset + rows.length, total)} of ${total}</span>
      <button class="btn" id="playersNext" ${s.offset + rows.length >= total ? "disabled" : ""}>Next →</button>
    </div>
    <div id="playerDetail"></div>
  `;

  document.getElementById("playerSearch").addEventListener("change", (e) => {
    s.search = e.target.value.trim();
    s.offset = 0;
    render();
  });
  document.getElementById("playerBotFilter").addEventListener("change", (e) => {
    s.isBot = e.target.value;
    s.offset = 0;
    render();
  });
  document.getElementById("playersPrev").addEventListener("click", () => {
    s.offset = Math.max(0, s.offset - 50);
    render();
  });
  document.getElementById("playersNext").addEventListener("click", () => {
    s.offset += 50;
    render();
  });
  els.content.querySelectorAll("th[data-sort]").forEach((th) => {
    th.addEventListener("click", () => {
      const col = th.dataset.sort;
      s.dir = s.sort === col && s.dir === "desc" ? "asc" : "desc";
      s.sort = col;
      render();
    });
  });
  els.content.querySelectorAll("tr[data-id]").forEach((tr) => {
    tr.addEventListener("click", () => togglePlayerDetail(Number(tr.dataset.id)));
  });

  if (s.expandedId && rows.some((p) => p.id === s.expandedId)) {
    await showPlayerDetail(s.expandedId);
  }
}

async function togglePlayerDetail(id) {
  state.players.expandedId = state.players.expandedId === id ? null : id;
  document.getElementById("playerDetail").innerHTML = "";
  if (state.players.expandedId) await showPlayerDetail(id);
}

async function showPlayerDetail(id) {
  const { player, recentGames, activeSessions } = await api(`/players/${id}`);

  const gameRows = recentGames
    .map(
      (g) => `<tr>
        <td>${esc(g.player0_nickname ?? "?")} vs ${esc(g.player1_nickname ?? "?")}</td>
        <td>${g.winner == null ? "draw" : g.winner === 0 ? esc(g.player0_nickname ?? "P0") : esc(g.player1_nickname ?? "P1")}</td>
        <td class="num">${g.score_0}–${g.score_1}</td>
        <td class="mono muted">${relTime(g.ended_at)}</td>
      </tr>`,
    )
    .join("");

  document.getElementById("playerDetail").innerHTML = `
    <div class="detail-panel">
      <h3>${esc(player.nickname)}</h3>
      <div class="kv-grid">
        <div><div class="k">Email</div><div class="v">${esc(player.email ?? "—")}</div></div>
        <div><div class="k">Games played</div><div class="v">${player.games_played}</div></div>
        <div><div class="k">Joined</div><div class="v">${fmtDate(player.created_at)}</div></div>
        <div><div class="k">Last rated game</div><div class="v">${relTime(player.last_rated_game_at)}</div></div>
        <div><div class="k">Active sessions</div><div class="v">${activeSessions.length}</div></div>
      </div>

      <div class="section-title">Adjust rating</div>
      <form class="inline-form" id="ratingForm">
        <label>Mu<input type="number" name="mu" value="${Math.round(player.rating_mu)}" step="1" /></label>
        <label>Sigma<input type="number" name="sigma" value="${Math.round(player.rating_sigma)}" step="1" /></label>
        <button class="btn btn--primary" type="submit">Save</button>
      </form>

      <div class="section-title">Recent games</div>
      ${
        recentGames.length
          ? `<table>
              <thead><tr><th>Match</th><th>Winner</th><th>Score</th><th>Ended</th></tr></thead>
              <tbody>${gameRows}</tbody>
            </table>`
          : `<div class="empty-state">No games yet.</div>`
      }
    </div>
  `;

  document.getElementById("ratingForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = new FormData(e.target);
    const mu = Number(form.get("mu"));
    const sigma = Number(form.get("sigma"));
    try {
      await api(`/players/${id}/rating`, { method: "POST", body: { mu, sigma } });
      showToast(`Rating updated for ${player.nickname}`);
      await renderPlayers();
    } catch (err) {
      showToast(err.message, true);
    }
  });
}

// ---------------------------------------------------------------- games --

async function renderGames() {
  const s = state.games;
  const params = new URLSearchParams({
    limit: "50",
    offset: String(s.offset),
    ...(s.player ? { player: s.player } : {}),
    ...(s.matchType ? { matchType: s.matchType } : {}),
    ...(s.origin ? { origin: s.origin } : {}),
  });
  const { rows, total } = await api(`/games?${params}`);
  els.viewMeta.textContent = `${total} total`;

  const tableRows = rows
    .map(
      (g) => `
      <tr class="is-clickable" data-id="${g.id}">
        <td>${esc(g.player0_nickname ?? "?")} vs ${esc(g.player1_nickname ?? "?")}</td>
        <td>${g.winner == null ? '<span class="muted">draw</span>' : g.winner === 0 ? '<span class="pill pill--a">P0</span>' : '<span class="pill pill--b">P1</span>'}</td>
        <td class="num">${g.score_0}–${g.score_1}</td>
        <td>${esc(g.match_type)}</td>
        <td class="muted">${esc(g.origin)}</td>
        <td class="mono muted">${relTime(g.ended_at)}</td>
      </tr>`,
    )
    .join("");

  els.content.innerHTML = `
    <div class="toolbar">
      <input type="text" id="gamePlayer" placeholder="filter by player id…" value="${esc(s.player)}" />
      <input type="text" id="gameMatchType" placeholder="match type…" value="${esc(s.matchType)}" />
      <input type="text" id="gameOrigin" placeholder="origin…" value="${esc(s.origin)}" />
    </div>
    ${
      rows.length
        ? `<table>
            <thead><tr><th>Players</th><th>Winner</th><th>Score</th><th>Type</th><th>Origin</th><th>Ended</th></tr></thead>
            <tbody>${tableRows}</tbody>
          </table>`
        : `<div class="empty-state">No games match this filter.</div>`
    }
    <div class="pagination">
      <button class="btn" id="gamesPrev" ${s.offset === 0 ? "disabled" : ""}>← Prev</button>
      <span>${rows.length ? s.offset + 1 : 0}–${Math.min(s.offset + rows.length, total)} of ${total}</span>
      <button class="btn" id="gamesNext" ${s.offset + rows.length >= total ? "disabled" : ""}>Next →</button>
    </div>
    <div id="gameDetail"></div>
  `;

  const applyFilter = (key, value) => {
    s[key] = value.trim();
    s.offset = 0;
    render();
  };
  document.getElementById("gamePlayer").addEventListener("change", (e) => applyFilter("player", e.target.value));
  document.getElementById("gameMatchType").addEventListener("change", (e) => applyFilter("matchType", e.target.value));
  document.getElementById("gameOrigin").addEventListener("change", (e) => applyFilter("origin", e.target.value));
  document.getElementById("gamesPrev").addEventListener("click", () => {
    s.offset = Math.max(0, s.offset - 50);
    render();
  });
  document.getElementById("gamesNext").addEventListener("click", () => {
    s.offset += 50;
    render();
  });
  els.content.querySelectorAll("tr[data-id]").forEach((tr) => {
    tr.addEventListener("click", () => toggleGameDetail(Number(tr.dataset.id)));
  });

  if (s.expandedId && rows.some((g) => g.id === s.expandedId)) {
    await showGameDetail(s.expandedId);
  }
}

async function toggleGameDetail(id) {
  state.games.expandedId = state.games.expandedId === id ? null : id;
  document.getElementById("gameDetail").innerHTML = "";
  if (state.games.expandedId) await showGameDetail(id);
}

async function showGameDetail(id) {
  const { game } = await api(`/games/${id}`);
  document.getElementById("gameDetail").innerHTML = `
    <div class="detail-panel">
      <h3>Game #${game.id}</h3>
      <div class="kv-grid">
        <div><div class="k">Player 0</div><div class="v">${esc(game.player0_nickname ?? "?")} (mu ${Math.round(game.mu_before_0 ?? 0)})</div></div>
        <div><div class="k">Player 1</div><div class="v">${esc(game.player1_nickname ?? "?")} (mu ${Math.round(game.mu_before_1 ?? 0)})</div></div>
        <div><div class="k">Score</div><div class="v">${game.score_0}–${game.score_1}</div></div>
        <div><div class="k">End reason</div><div class="v">${esc(game.end_reason ?? "—")}</div></div>
        <div><div class="k">Started</div><div class="v">${fmtDate(game.started_at)}</div></div>
        <div><div class="k">Ended</div><div class="v">${fmtDate(game.ended_at)}</div></div>
      </div>
    </div>
  `;
}

// ----------------------------------------------------------------- bots --

async function renderBots() {
  const [{ bots }, { keys }] = await Promise.all([api("/bots"), api("/bot-keys")]);
  els.viewMeta.textContent = `${bots.length} bots`;

  const rows = bots
    .map((b) => {
      const key = b.google_sub?.startsWith("bot:") ? b.google_sub.slice(4) : "?";
      return `
      <tr>
        <td>${esc(b.nickname)}</td>
        <td class="mono muted">${esc(key)}</td>
        <td class="num">${Math.round(b.rating_mu)} ± ${Math.round(b.rating_sigma)}</td>
        <td class="mono">${b.games_played}</td>
        <td>${b.is_active ? '<span class="pill pill--live">active</span>' : '<span class="pill pill--danger">disabled</span>'}</td>
        <td>
          <button class="btn" data-toggle="${b.id}" data-active="${b.is_active}">${b.is_active ? "Disable" : "Enable"}</button>
          <button class="btn" data-perf="${b.id}">Performance</button>
        </td>
      </tr>`;
    })
    .join("");

  els.content.innerHTML = `
    ${
      bots.length
        ? `<table>
            <thead><tr><th>Nickname</th><th>Key</th><th>Rating</th><th>Games</th><th>Status</th><th></th></tr></thead>
            <tbody>${rows}</tbody>
          </table>`
        : `<div class="empty-state">No bots seeded yet.</div>`
    }

    <div class="section-title">Seed a new bot</div>
    <form class="inline-form" id="seedForm">
      <label>Strategy
        <select name="key">
          ${keys.map((k) => `<option value="${esc(k)}">${esc(k)}</option>`).join("")}
        </select>
      </label>
      <label>Nickname<input type="text" name="nickname" placeholder="Bot_Name" style="width:160px" /></label>
      <button class="btn btn--primary" type="submit">Add bot</button>
    </form>

    <div id="botDetail"></div>
  `;

  document.getElementById("seedForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = new FormData(e.target);
    const nickname = form.get("nickname").trim();
    if (!nickname) return showToast("Nickname is required", true);
    try {
      const { bot } = await api("/bots", { method: "POST", body: { key: form.get("key"), nickname } });
      showToast(`Bot ready: ${bot.nickname}`);
      e.target.reset();
      await renderBots();
    } catch (err) {
      showToast(err.message, true);
    }
  });

  els.content.querySelectorAll("[data-toggle]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = Number(btn.dataset.toggle);
      // b.is_active comes straight from better-sqlite3 as a raw 0/1
      // integer, so the dataset attribute below is the *string* "1" or
      // "0" — never the literal "true".
      const currentlyActive = btn.dataset.active === "1";
      try {
        await api(`/bots/${id}/active`, { method: "POST", body: { active: !currentlyActive } });
        await renderBots();
      } catch (err) {
        showToast(err.message, true);
      }
    });
  });

  els.content.querySelectorAll("[data-perf]").forEach((btn) => {
    btn.addEventListener("click", () => toggleBotPerformance(Number(btn.dataset.perf)));
  });

  if (state.bots.expandedId && bots.some((b) => b.id === state.bots.expandedId)) {
    await showBotPerformance(state.bots.expandedId);
  }
}

async function toggleBotPerformance(id) {
  state.bots.expandedId = state.bots.expandedId === id ? null : id;
  document.getElementById("botDetail").innerHTML = "";
  if (state.bots.expandedId) await showBotPerformance(id);
}

async function showBotPerformance(id) {
  const perf = await api(`/bots/${id}/performance`);
  const bandRows = perf.byBand
    .map(
      (b) => `<tr>
        <td class="mono">${esc(b.band)}</td>
        <td class="mono">${b.games}</td>
        <td class="num">${b.winRate == null ? "—" : `${Math.round(b.winRate * 100)}%`}</td>
        <td class="mono muted">${b.wins}W ${b.losses}L ${b.draws}D</td>
      </tr>`,
    )
    .join("");

  document.getElementById("botDetail").innerHTML = `
    <div class="detail-panel">
      <h3>Performance</h3>
      <div class="kv-grid">
        <div><div class="k">Total games</div><div class="v">${perf.totalGames}</div></div>
        <div><div class="k">Overall win rate</div><div class="v">${perf.overall.winRate == null ? "—" : `${Math.round(perf.overall.winRate * 100)}%`}</div></div>
        <div><div class="k">Record</div><div class="v">${perf.overall.wins}W ${perf.overall.losses}L ${perf.overall.draws}D</div></div>
      </div>
      ${
        perf.byBand.length
          ? `<div class="section-title">By opponent rating band</div>
            <table>
              <thead><tr><th>Band</th><th>Games</th><th>Win rate</th><th>Record</th></tr></thead>
              <tbody>${bandRows}</tbody>
            </table>`
          : `<div class="empty-state">No completed games with a recorded opponent rating yet.</div>`
      }
    </div>
  `;
}

// ---------------------------------------------------------------- logs --

async function renderLogs() {
  const { lines } = await api("/logs?limit=300");
  els.viewMeta.textContent = `last ${lines.length} lines`;
  els.content.innerHTML = `<div class="log-lines">${lines.map((l) => esc(l)).join("\n")}</div>`;
}

// --------------------------------------------------------------- start --

setView("status");
