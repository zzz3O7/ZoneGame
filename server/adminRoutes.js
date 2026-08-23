import { isAdminConfigured, isAuthorizedAdmin } from "./adminAuth.js";
import { getRecentLogs, log } from "./logger.js";
import { listBotPlayers, setBotActive, findOrCreateBotPlayer, botKeyFromRow } from "./bot/botRepository.js";
import { KNOWN_BOT_KEYS } from "./bot/botRegistry.js";
import { processMetrics } from "./metrics.js";
import { versionInfo } from "./version.js";
import {
  listPlayers,
  getPlayerDetail,
  listGames,
  getGameDetail,
  adminSetPlayerRating,
  getBotPerformance,
} from "./adminRepository.js";

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

// Reads and JSON-parses a request body, capped so a misbehaving/malicious
// client can't stream an unbounded body into memory. Returns null (not a
// throw) for empty/invalid bodies — every write route below treats a
// null body as a 400, so this keeps that check in one place.
const MAX_BODY_BYTES = 64 * 1024;
function readJsonBody(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve(null);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

// Sane bounds for a manual rating overwrite — generous enough to never
// get in the way of a legitimate correction, tight enough to catch an
// obvious typo (e.g. an extra digit) before it hits the DB.
const MU_BOUNDS = [-1000, 10000];
const SIGMA_BOUNDS = [1, 2000];
function inBounds(n, [lo, hi]) {
  return typeof n === "number" && Number.isFinite(n) && n >= lo && n <= hi;
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
  if (parts.length === 2 && parts[1] === "bots" && req.method === "GET") {
    json(res, 200, { bots: listBotPlayers() });
    return true;
  }

  // GET /admin/bot-keys — known strategy keys, for populating a "seed a
  // new bot" form without hardcoding the list on the client.
  if (parts.length === 2 && parts[1] === "bot-keys" && req.method === "GET") {
    json(res, 200, { keys: KNOWN_BOT_KEYS });
    return true;
  }

  // POST /admin/bots  { key, nickname } — seed a new bot row for a known
  // strategy tier (see botRegistry.js). Idempotent: re-posting the same
  // key returns the existing row rather than erroring, same as the
  // seedBots.js script this replaces for ad-hoc use.
  if (parts.length === 2 && parts[1] === "bots" && req.method === "POST") {
    const body = await readJsonBody(req);
    if (!body || typeof body.key !== "string" || typeof body.nickname !== "string" || !body.nickname.trim()) {
      return json(res, 400, { error: "Body must be { key, nickname }" }), true;
    }
    if (!KNOWN_BOT_KEYS.includes(body.key)) {
      return json(res, 400, { error: `Unknown bot key. Known keys: ${KNOWN_BOT_KEYS.join(", ")}` }), true;
    }
    const bot = findOrCreateBotPlayer(body.key, body.nickname.trim());
    log(`admin: seeded/fetched bot ${bot.nickname} (id=${bot.id}, key=${body.key})`);
    json(res, 200, { bot });
    return true;
  }

  // POST /admin/bots/:id/active  { active: boolean }
  if (parts.length === 4 && parts[1] === "bots" && parts[3] === "active" && req.method === "POST") {
    const id = parseId(parts[2]);
    if (id == null) return json(res, 400, { error: "Invalid bot id" }), true;
    const body = await readJsonBody(req);
    if (!body || typeof body.active !== "boolean") return json(res, 400, { error: "Body must be { active: boolean }" }), true;
    const changed = setBotActive(id, body.active);
    if (!changed) return json(res, 404, { error: "No bot with that id" }), true;
    log(`admin: bot id=${id} set ${body.active ? "active" : "inactive"}`);
    json(res, 200, { id, active: body.active });
    return true;
  }

  // GET /admin/bots/:id/performance — win rate overall + by opponent rating band
  if (parts.length === 4 && parts[1] === "bots" && parts[3] === "performance" && req.method === "GET") {
    const id = parseId(parts[2]);
    if (id == null) return json(res, 400, { error: "Invalid bot id" }), true;
    json(res, 200, getBotPerformance(id));
    return true;
  }

  // GET /admin/logs?limit=200
  if (parts.length === 2 && parts[1] === "logs" && req.method === "GET") {
    json(res, 200, { lines: getRecentLogs(Number(q.get("limit")) || 200) });
    return true;
  }

  // GET /admin/version — which commit/branch this process is actually running
  if (parts.length === 2 && parts[1] === "version" && req.method === "GET") {
    json(res, 200, versionInfo);
    return true;
  }

  // GET /admin/metrics — process health + ws traffic rate
  if (parts.length === 2 && parts[1] === "metrics" && req.method === "GET") {
    json(res, 200, processMetrics());
    return true;
  }

  // GET /admin/players?search=&isBot=&sort=&dir=&limit=&offset=
  if (parts.length === 2 && parts[1] === "players" && req.method === "GET") {
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
  if (parts.length === 3 && parts[1] === "players" && req.method === "GET") {
    const id = parseId(parts[2]);
    if (id == null) return json(res, 400, { error: "Invalid player id" }), true;
    const detail = getPlayerDetail(id);
    if (!detail) return json(res, 404, { error: "Player not found" }), true;
    json(res, 200, detail);
    return true;
  }

  // POST /admin/players/:id/rating  { mu, sigma } — direct overwrite for
  // correcting a bad value; does NOT go through the normal match-result
  // rating update in rating.js. Logged, not otherwise audited in the DB.
  if (parts.length === 4 && parts[1] === "players" && parts[3] === "rating" && req.method === "POST") {
    const id = parseId(parts[2]);
    if (id == null) return json(res, 400, { error: "Invalid player id" }), true;
    const body = await readJsonBody(req);
    if (!body || !inBounds(body.mu, MU_BOUNDS) || !inBounds(body.sigma, SIGMA_BOUNDS)) {
      return (
        json(res, 400, {
          error: `Body must be { mu, sigma } with mu in [${MU_BOUNDS}] and sigma in [${SIGMA_BOUNDS}]`,
        }),
        true
      );
    }
    const result = adminSetPlayerRating(id, body.mu, body.sigma);
    if (!result) return json(res, 404, { error: "Player not found" }), true;
    log(
      `admin: rating override for ${result.nickname} (id=${id}): ` +
        `mu ${result.before.rating_mu}->${result.after.rating_mu}, sigma ${result.before.rating_sigma}->${result.after.rating_sigma}`,
    );
    json(res, 200, result);
    return true;
  }

  // GET /admin/games?player=&matchType=&origin=&sort=&dir=&limit=&offset=
  if (parts.length === 2 && parts[1] === "games" && req.method === "GET") {
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
  if (parts.length === 3 && parts[1] === "games" && req.method === "GET") {
    const id = parseId(parts[2]);
    if (id == null) return json(res, 400, { error: "Invalid game id" }), true;
    const detail = getGameDetail(id);
    if (!detail) return json(res, 404, { error: "Game not found" }), true;
    json(res, 200, { game: detail });
    return true;
  }

  json(res, 404, { error: "Unknown admin route, or wrong method for that route" });
  return true;
}
