import { db } from "./db.js";

// Read-only queries for the admin tool. Deliberately kept separate from
// playerRepository.js/gameRepository.js — those are the gameplay-facing
// data access points with a narrow, trusted contract; this module is
// allowed to build ad-hoc filtered/paginated queries that no in-game
// code path needs, without pushing that surface into the files real
// game logic depends on.

const SORTABLE_PLAYER_COLUMNS = new Set(["rating_mu", "games_played", "created_at", "nickname"]);
const SORTABLE_GAME_COLUMNS = new Set(["started_at", "ended_at"]);

function clampLimit(limit, fallback = 50, max = 200) {
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

function clampOffset(offset) {
  const n = Number(offset);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

// { search, isBot, sort, dir, limit, offset } -> { rows, total }
export function listPlayers({ search, isBot, sort = "created_at", dir = "desc", limit, offset } = {}) {
  const where = [];
  const params = {};
  if (search) {
    where.push("nickname LIKE @search OR email LIKE @search");
    params.search = `%${search}%`;
  }
  if (isBot === "true" || isBot === true) where.push("is_bot = 1");
  if (isBot === "false" || isBot === false) where.push("is_bot = 0");
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const sortCol = SORTABLE_PLAYER_COLUMNS.has(sort) ? sort : "created_at";
  const sortDir = dir === "asc" ? "ASC" : "DESC";

  const lim = clampLimit(limit);
  const off = clampOffset(offset);

  const rows = db
    .prepare(
      `SELECT id, nickname, email, rating_mu, rating_sigma, games_played, is_bot, created_at, last_rated_game_at
       FROM players ${whereSql}
       ORDER BY ${sortCol} ${sortDir}
       LIMIT @limit OFFSET @offset`,
    )
    .all({ ...params, limit: lim, offset: off });

  const total = db.prepare(`SELECT COUNT(*) AS n FROM players ${whereSql}`).get(params).n;

  return { rows, total, limit: lim, offset: off };
}

export function getPlayerDetail(id) {
  const player = db.prepare(`SELECT * FROM players WHERE id = ?`).get(id);
  if (!player) return null;
  const recentGames = db
    .prepare(
      `SELECT g.*, p0.nickname AS player0_nickname, p1.nickname AS player1_nickname
       FROM games g
       LEFT JOIN players p0 ON p0.id = g.player0_id
       LEFT JOIN players p1 ON p1.id = g.player1_id
       WHERE g.player0_id = ? OR g.player1_id = ?
       ORDER BY g.ended_at DESC
       LIMIT 25`,
    )
    .all(id, id);
  const activeSessions = db
    .prepare(`SELECT id, created_at, expires_at FROM sessions WHERE player_id = ? ORDER BY created_at DESC`)
    .all(id);
  return { player, recentGames, activeSessions };
}

// { player, matchType, origin, sort, dir, limit, offset } -> { rows, total }
export function listGames({ player, matchType, origin, sort = "ended_at", dir = "desc", limit, offset } = {}) {
  const where = [];
  const params = {};
  if (player) {
    where.push("(player0_id = @player OR player1_id = @player)");
    params.player = player;
  }
  if (matchType) {
    where.push("match_type = @matchType");
    params.matchType = matchType;
  }
  if (origin) {
    where.push("origin = @origin");
    params.origin = origin;
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const sortCol = SORTABLE_GAME_COLUMNS.has(sort) ? sort : "ended_at";
  const sortDir = dir === "asc" ? "ASC" : "DESC";

  const lim = clampLimit(limit);
  const off = clampOffset(offset);

  const rows = db
    .prepare(
      `SELECT g.id, g.player0_id, g.player1_id, p0.nickname AS player0_nickname, p1.nickname AS player1_nickname,
              g.winner, g.score_0, g.score_1, g.end_reason, g.match_type, g.origin,
              g.started_at, g.ended_at
       FROM games g
       LEFT JOIN players p0 ON p0.id = g.player0_id
       LEFT JOIN players p1 ON p1.id = g.player1_id
       ${whereSql}
       ORDER BY g.${sortCol} ${sortDir}
       LIMIT @limit OFFSET @offset`,
    )
    .all({ ...params, limit: lim, offset: off });

  const total = db.prepare(`SELECT COUNT(*) AS n FROM games g ${whereSql}`).get(params).n;

  return { rows, total, limit: lim, offset: off };
}

export function getGameDetail(id) {
  return (
    db
      .prepare(
        `SELECT g.*, p0.nickname AS player0_nickname, p1.nickname AS player1_nickname
       FROM games g
       LEFT JOIN players p0 ON p0.id = g.player0_id
       LEFT JOIN players p1 ON p1.id = g.player1_id
       WHERE g.id = ?`,
      )
      .get(id) || null
  );
}
