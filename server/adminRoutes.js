import { isAdminConfigured, isAuthorizedAdmin } from "./adminAuth.js";
import { getRecentLogs } from "./logger.js";
import { listBotPlayers } from "./bot/botRepository.js";
import { listPlayers, getPlayerDetail, listGames, getGameDetail } from "./adminRepository.js";

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

// A live Match's `players` entries hold a raw `agent` (which wraps a
// real ws) — never send that over the wire. This is the one place that
// turns a Match into something JSON-safe, used for both the list and
// detail views (detail just includes more of the same match's fields).
function summarizePlayer(p) {
  return {
    nickname: p.nickname,
    playerIndex: p.playerIndex,
    accountPlayerId: p.accountPlayerId,
    connected: p.connected,
    sessionId: p.sessionId,
  };
}

function summarizeMatch(match) {
  return {
    matchId: match.matchId,
    inviteCode: match.inviteCode,
    status: match.status,
    rated: match.rated,
    matchType: match.matchType,
    origin: match.origin,
    players: match.players.map(summarizePlayer),
    startedAt: match._gameStartedAt,
    endInfo: match.endInfo,
  };
}

function detailMatch(match) {
  const now = Date.now();
  const game = match.game;
  return {
    ...summarizeMatch(match),
    params: match.activeParams,
    actionCount: match.actions.length,
    clock: match.clock ? match.clock.snapshot(now) : null,
    game: game
      ? {
          currentPlayerIndex: game.currentPlayerIndex,
          gameOver: game.gameOver,
          boardSize: game.boardSize,
          totalBoardPoints: game.totalBoardPoints,
          scores: game.players.map((p) => p.score),
        }
      : null,
  };
}

// manager is needed here (not just the ws) because a HumanAgent doesn't
// hold a match reference itself — only its bound sessionId does, and
// that's only resolvable via MatchManager.findMatchByAgent (see
// matchManager.js's bindAgent/findMatchByAgent).
function summarizeConnection(ws, manager) {
  const match = ws.__agent ? manager.findMatchByAgent(ws.__agent) : null;
  return {
    accountPlayerId: ws.__accountPlayer?.id ?? null,
    nickname: ws.__accountPlayer?.nickname ?? null,
    connectedAt: ws.__connectedAt ?? null,
    ip: ws.__ip ?? null,
    isAlive: ws.isAlive,
    inMatchId: match?.matchId ?? null,
    readyState: ws.readyState,
  };
}

function parseId(str) {
  const n = Number(str);
  return Number.isInteger(n) ? n : null;
}

// ctx: { manager, queue, wss }. Returns true if this request was handled
// (including auth failures), false if the caller should try something
// else — same contract as authRoutes.js/staticServer.js so index.js can
// chain all three the same way.
export async function handleAdminRequest(req, res, url, ctx) {
  if (!url.pathname.startsWith("/admin/")) return false;

  if (!isAdminConfigured()) {
    json(res, 503, { error: "Admin tool not configured — set ADMIN_TOKEN in server/.env and restart." });
    return true;
  }
  if (!isAuthorizedAdmin(req)) {
    json(res, 401, { error: "Unauthorized" });
    return true;
  }
  if (req.method !== "GET") {
    json(res, 405, { error: "Only GET is supported right now" });
    return true;
  }

  const { manager, queue, wss } = ctx;
  const parts = url.pathname.split("/").filter(Boolean); // ["admin", ...]
  const q = url.searchParams;

  // GET /admin/status — quick overview for a dashboard landing view.
  if (parts.length === 2 && parts[1] === "status") {
    const matches = manager.listMatches();
    json(res, 200, {
      uptimeSec: Math.round(process.uptime()),
      connections: wss.clients.size,
      matches: {
        total: matches.length,
        byStatus: matches.reduce((acc, m) => ((acc[m.status] = (acc[m.status] || 0) + 1), acc), {}),
      },
      queue: queue.snapshot(),
    });
    return true;
  }

  // GET /admin/matches
  if (parts.length === 2 && parts[1] === "matches") {
    json(res, 200, { matches: manager.listMatches().map(summarizeMatch) });
    return true;
  }

  // GET /admin/matches/:id
  if (parts.length === 3 && parts[1] === "matches") {
    const match = manager.getMatch(parts[2]);
    if (!match) return json(res, 404, { error: "Match not found" }), true;
    json(res, 200, { match: detailMatch(match) });
    return true;
  }

  // GET /admin/connections
  if (parts.length === 2 && parts[1] === "connections") {
    json(res, 200, { connections: [...wss.clients].map((ws) => summarizeConnection(ws, manager)) });
    return true;
  }

  // GET /admin/queue
  if (parts.length === 2 && parts[1] === "queue") {
    json(res, 200, queue.snapshot());
    return true;
  }

  // GET /admin/bots
  if (parts.length === 2 && parts[1] === "bots") {
    json(res, 200, { bots: listBotPlayers() });
    return true;
  }

  // GET /admin/logs?limit=200
  if (parts.length === 2 && parts[1] === "logs") {
    json(res, 200, { lines: getRecentLogs(Number(q.get("limit")) || 200) });
    return true;
  }

  // GET /admin/players?search=&isBot=&sort=&dir=&limit=&offset=
  if (parts.length === 2 && parts[1] === "players") {
    const result = listPlayers({
      search: q.get("search") || undefined,
      isBot: q.get("isBot") || undefined,
      sort: q.get("sort") || undefined,
      dir: q.get("dir") || undefined,
      limit: q.get("limit") || undefined,
      offset: q.get("offset") || undefined,
    });
    json(res, 200, result);
    return true;
  }

  // GET /admin/players/:id
  if (parts.length === 3 && parts[1] === "players") {
    const id = parseId(parts[2]);
    if (id == null) return json(res, 400, { error: "Invalid player id" }), true;
    const detail = getPlayerDetail(id);
    if (!detail) return json(res, 404, { error: "Player not found" }), true;
    json(res, 200, detail);
    return true;
  }

  // GET /admin/games?player=&matchType=&origin=&sort=&dir=&limit=&offset=
  if (parts.length === 2 && parts[1] === "games") {
    const result = listGames({
      player: q.get("player") ? parseId(q.get("player")) : undefined,
      matchType: q.get("matchType") || undefined,
      origin: q.get("origin") || undefined,
      sort: q.get("sort") || undefined,
      dir: q.get("dir") || undefined,
      limit: q.get("limit") || undefined,
      offset: q.get("offset") || undefined,
    });
    json(res, 200, result);
    return true;
  }

  // GET /admin/games/:id
  if (parts.length === 3 && parts[1] === "games") {
    const id = parseId(parts[2]);
    if (id == null) return json(res, 400, { error: "Invalid game id" }), true;
    const detail = getGameDetail(id);
    if (!detail) return json(res, 404, { error: "Game not found" }), true;
    json(res, 200, { game: detail });
    return true;
  }

  json(res, 404, { error: "Unknown admin route" });
  return true;
}
