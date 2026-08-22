import http from "http";
import { WebSocketServer } from "ws";
import { MatchManager } from "./matchManager.js";
import { HumanAgent, BotAgent } from "./playerAgent.js";
import { MSG } from "../shared/net/protocol.js";
import { log, shortId } from "./logger.js";
import { handleAuthRequest } from "./authRoutes.js";
import { serveStatic } from "./staticServer.js";
import { readSessionCookie } from "./cookies.js";
import { getSessionPlayer } from "./sessionStore.js";
import { MatchmakingQueue } from "./matchmakingQueue.js";
import {
  MATCHMAKING_TIME_MODES,
  MATCHMAKING_SWEEP_INTERVAL_MS,
  MATCHMAKING_BOT_FALLBACK_MS,
  TIME_PRESETS,
} from "../shared/config.js";
import { applyInactivityRegrowth } from "./rating.js";
import { chooseMoveForBotKey } from "./bot/botRegistry.js";
import { listBotPlayers, pickClosestBot, botKeyFromRow } from "./bot/botRepository.js";
import { displayRating } from "./playerRepository.js";

// A plain http.Server sits in front of the WS server now, because
// Google's OAuth redirect (GET /auth/google/callback) is a real browser
// navigation, not something that can arrive over a WebSocket.
//
// Static file serving (client/ + shared/) is included here for local
// dev convenience only — in production nginx serves those paths
// directly and requests for them never reach this process at all.
const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (await handleAuthRequest(req, res, url)) return;
  if (await serveStatic(req, res, url)) return;
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server: httpServer });
const manager = new MatchManager();
const queue = new MatchmakingQueue();

// mu/sigma snapshot for matchmaking purposes, taken once at queue-join
// time. Applies inactivity regrowth (a player back after a long break
// should read as uncertain, not still pinned at their old converged
// sigma) but deliberately skips it for guests (accountPlayer == null —
// nothing to regrow) and does NOT re-apply it while queued; a queue wait
// is seconds, not days, so it isn't worth recomputing per comparison.
function ratingSnapshotFor(accountPlayer) {
  if (!accountPlayer) return { mu: null, sigma: null };
  return {
    mu: accountPlayer.rating_mu,
    sigma: applyInactivityRegrowth(accountPlayer.rating_sigma, accountPlayer.last_rated_game_at, Date.now()),
  };
}

// Builds the match for a completed queue pairing and notifies both
// sockets — the one path used by both an immediate on-join pairing and
// a later sweep() pairing, so there's exactly one place that turns a
// [entryA, entryB, resolvedTimeMode] tuple into a live match.
function matchPair(a, b, resolvedTimeMode, rated) {
  // Board preset is always "classic" for matchmaking today — see the
  // comment atop matchmakingQueue.js.
  const params = { mode: "classic", timeMode: resolvedTimeMode };
  // Queue entries still carry a raw ws (see matchmakingQueue.js — not
  // agent-based yet, only human players reach the queue today). Resolve
  // each entry's already-bound agent here, at the boundary where
  // matchManager takes over.
  const agentA = { ...a, agent: a.ws.__agent };
  const agentB = { ...b, agent: b.ws.__agent };
  const { match, players } = manager.createMatchForPair(agentA, agentB, params, rated);
  [a, b].forEach((entry, i) => {
    entry.ws.send(
      JSON.stringify({
        type: MSG.QUEUE_MATCHED,
        matchId: match.matchId,
        inviteCode: match.inviteCode,
        yourPlayerIndex: players[i].playerIndex,
        sessionId: players[i].sessionId,
        rated: match.rated,
      }),
    );
  });
}

// Called once a queued entry has waited MATCHMAKING_BOT_FALLBACK_MS
// with no human pairing found — see matchmakingQueue.js's expireStale()
// and docs/BOTS.md point 5. Builds a PvE match against the closest
// available bot, same QUEUE_MATCHED shape as a human pairing so the
// client can't tell the difference from the message alone.
function matchBotFallback(entry, resolvedTimeMode, rated, remove) {
  const bot = pickClosestBot(entry.mu);
  if (!bot) {
    // No bots seeded yet (server/scripts/seedBots.js never run, or the
    // pool's empty for some other reason) — leave the entry queued
    // exactly as it was rather than dropping it. It keeps getting a
    // fair shot at a human pair via the normal sweep() widening window,
    // and gets re-checked here again on the next tick once a bot
    // actually exists to fall back to.
    return;
  }
  remove(); // only now, since a fallback is actually about to happen
  const params = { mode: "classic", timeMode: resolvedTimeMode };
  const { match, human } = manager.createPvEMatch({
    humanNickname: entry.nickname,
    humanAgent: entry.ws.__agent,
    humanAccountPlayerId: entry.accountPlayerId,
    botNickname: bot.nickname,
    botAccountPlayerId: bot.id,
    makeBotAgent: (m) => new BotAgent(m, chooseMoveForBotKey(botKeyFromRow(bot))),
    params,
    rated,
    origin: "matchmaking",
  });
  entry.ws.send(
    JSON.stringify({
      type: MSG.QUEUE_MATCHED,
      matchId: match.matchId,
      inviteCode: match.inviteCode,
      yourPlayerIndex: human.playerIndex,
      sessionId: human.sessionId,
      rated: match.rated,
    }),
  );
}

function heartbeat() {
  this.isAlive = true;
}

// Rated is restricted to recognized, actually-timed presets — same set
// matchmaking already uses by construction. TIME_PRESETS.none is a real
// (truthy) entry — "no clock" is itself a recognized preset for normal
// play, just not a comparable one for rating purposes, so it needs an
// explicit exclusion here rather than a plain truthiness check.
const RATED_TIME_MODES = MATCHMAKING_TIME_MODES.filter((m) => m !== "any");

// CREATE_MATCH's params arrive already resolved via shared/params.js's
// resolveParams() (client calls it in Menu.buildParams(), and it's
// idempotent so re-running it here is fine) — that means params carries
// `timeControl: { initialMs, incrementMs } | null`, NOT a `timeMode`
// string (unlike matchPair/matchBotFallback above, which build params
// directly server-side and so still have a real timeMode). So rated
// eligibility here has to be checked by comparing the resolved
// timeControl against the RATED_TIME_MODES presets' values, not by
// looking for a timeMode key that this shape never has.
function isRatedTimeControl(timeControl) {
  if (!timeControl) return false;
  return RATED_TIME_MODES.some((m) => {
    const preset = TIME_PRESETS[m];
    return preset && preset.initialMs === timeControl.initialMs && preset.incrementMs === timeControl.incrementMs;
  });
}

wss.on("connection", (ws, req) => {
  ws.isAlive = true;
  ws.on("pong", heartbeat);

  // Resolves account identity once, from the cookie sent on the WS
  // upgrade request — same cookie/session the HTTP /auth/* routes use.
  // null for guests. Not re-checked per-message: if a session is
  // revoked mid-connection the player just keeps whatever identity they
  // connected with until they reconnect, which is fine for now.
  const sessionId = readSessionCookie(req);
  ws.__accountPlayer = sessionId ? getSessionPlayer(sessionId) : null;
  // Built once per connection (including a "reconnect", which is just a
  // fresh connection from the WS server's point of view) — every match.*
  // call below goes through this agent, never the raw ws directly.
  ws.__agent = new HumanAgent(ws);

  // prevent unhandled 'error' crashing whole process
  ws.on("error", (err) => {
    console.error("ws error:", err.message);
  });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      log("Malformed message received (JSON parse failed)");
      return;
    }

    try {
      if (msg.type === MSG.CREATE_MATCH) {
        const rated = Boolean(msg.rated);

        // Rated is restricted to a recognized, actually-timed preset —
        // same reasoning as matchmaking (which enforces this by
        // construction). An arbitrary custom board or custom/no clock
        // would mean a rated game isn't comparable to any other rated
        // game, which breaks the rating system's core assumption now
        // and blocks ever splitting ratings per-mode later (see
        // docs/BOTS.md-adjacent plans for that). See isRatedTimeControl
        // above for why this compares timeControl values rather than a
        // timeMode string.
        if (rated && (msg.params?.mode !== "classic" || !isRatedTimeControl(msg.params?.timeControl))) {
          ws.send(
            JSON.stringify({
              type: MSG.ERROR,
              message: "Rated matches require the Classic board and a preset time control",
            }),
          );
          return;
        }
        if (rated && !ws.__accountPlayer) {
          ws.send(JSON.stringify({ type: MSG.ERROR, message: "Log in to create a rated match" }));
          return;
        }
        if (rated && !ws.__accountPlayer.nickname) {
          ws.send(JSON.stringify({ type: MSG.ERROR, message: "Set a nickname before creating a rated match" }));
          return;
        }

        // Same rule as JOIN_QUEUE: rated always uses the account's own
        // nickname, never a client-supplied one.
        const nickname = rated ? ws.__accountPlayer.nickname : msg.nickname;
        const { match, player } = manager.createMatch(
          nickname,
          ws.__agent,
          msg.params,
          ws.__accountPlayer?.id ?? null,
          rated,
        );
        ws.send(
          JSON.stringify({
            type: MSG.MATCH_CREATED,
            matchId: match.matchId,
            inviteCode: match.inviteCode,
            yourPlayerIndex: player.playerIndex,
            sessionId: player.sessionId,
            rated: match.rated,
          }),
        );
        return;
      }

      // Read-only peek before actually joining — see docs on
      // MATCH_PREVIEW_REQUEST in protocol.js. Deliberately doesn't touch
      // manager/match state at all; the real join still happens via the
      // normal JOIN_MATCH handler above once the client sends it.
      if (msg.type === MSG.MATCH_PREVIEW_REQUEST) {
        const target = manager.matchesByCode.get(msg.inviteCode);
        if (!target) {
          ws.send(JSON.stringify({ type: MSG.ERROR, message: "Match not found" }));
          return;
        }
        if (target.isFull()) {
          ws.send(JSON.stringify({ type: MSG.ERROR, message: "Match already full" }));
          return;
        }
        ws.send(
          JSON.stringify({
            type: MSG.MATCH_PREVIEW,
            inviteCode: msg.inviteCode,
            params: target.params, // pre-seed config only — activeParams/seed doesn't exist until _start()
            rated: target.rated,
            creatorNickname: target.players[0]?.nickname ?? "Player",
          }),
        );
        return;
      }

      if (msg.type === MSG.JOIN_MATCH) {
        // Peeked before joining so the login check (and nickname source)
        // can depend on whether the match being joined is rated — the
        // creator decided that at CREATE_MATCH time, the joiner just has
        // to meet the same bar. matchesByCode is plain manager state
        // (direct access, no separate lookup method needed for a peek).
        const target = manager.matchesByCode.get(msg.inviteCode);
        if (target?.rated && !ws.__accountPlayer) {
          ws.send(JSON.stringify({ type: MSG.ERROR, message: "Log in to join a rated match" }));
          return;
        }
        if (target?.rated && !ws.__accountPlayer.nickname) {
          ws.send(JSON.stringify({ type: MSG.ERROR, message: "Set a nickname before joining a rated match" }));
          return;
        }
        const nickname = target?.rated ? ws.__accountPlayer.nickname : msg.nickname;

        const result = manager.joinMatch(msg.inviteCode, nickname, ws.__agent, ws.__accountPlayer?.id ?? null);
        if (result.error) {
          ws.send(JSON.stringify({ type: MSG.ERROR, message: result.error }));
          return;
        }
        const { match, player } = result;
        ws.send(
          JSON.stringify({
            type: MSG.MATCH_JOINED,
            matchId: match.matchId,
            yourPlayerIndex: player.playerIndex,
            sessionId: player.sessionId,
          }),
        );
        return;
      }

      // Matchmaking modes 2 (unrated) and 3 (rated) — separate from the
      // invite-code create/join flow above, which is always unrated.
      if (msg.type === MSG.JOIN_QUEUE) {
        const rated = Boolean(msg.rated);

        if (rated && !ws.__accountPlayer) {
          ws.send(JSON.stringify({ type: MSG.ERROR, message: "Log in to play rated matches" }));
          return;
        }
        if (rated && !ws.__accountPlayer.nickname) {
          ws.send(JSON.stringify({ type: MSG.ERROR, message: "Set a nickname before playing rated matches" }));
          return;
        }
        if (!MATCHMAKING_TIME_MODES.includes(msg.timeMode)) {
          ws.send(JSON.stringify({ type: MSG.ERROR, message: "Invalid time control" }));
          return;
        }

        // Rated always uses the account's own nickname (never a
        // client-supplied one); unrated matchmaking accepts guests, so
        // it takes whatever nickname the client sent, same as invite-code play.
        const nickname = rated ? ws.__accountPlayer.nickname : msg.nickname;
        if (!nickname) {
          ws.send(JSON.stringify({ type: MSG.ERROR, message: "Nickname required" }));
          return;
        }

        const entry = {
          nickname,
          accountPlayerId: ws.__accountPlayer?.id ?? null,
          ...ratingSnapshotFor(ws.__accountPlayer),
        };
        const pair = queue.join(ws, entry, rated, msg.timeMode);
        if (!pair) {
          ws.send(JSON.stringify({ type: MSG.QUEUED }));
          return;
        }

        const [a, b, resolvedTimeMode] = pair;
        matchPair(a, b, resolvedTimeMode, rated);
        return;
      }

      if (msg.type === MSG.LEAVE_QUEUE) {
        queue.leave(ws);
        ws.send(JSON.stringify({ type: MSG.QUEUE_CANCELLED }));
        return;
      }

      if (msg.type === MSG.BOT_LIST_REQUEST) {
        const bots = listBotPlayers().map((b) => ({ id: b.id, nickname: b.nickname, rating: displayRating(b) }));
        ws.send(JSON.stringify({ type: MSG.BOT_LIST, bots }));
        return;
      }

      // Direct-debug PvE — bypasses the queue, always unrated, zero move
      // delay on the bot's side. See docs/BOTS.md "direct_debug" origin.
      if (msg.type === MSG.PLAY_BOT_REQUEST) {
        const bots = listBotPlayers();
        const bot = bots.find((b) => b.id === msg.botId);
        if (!bot) {
          ws.send(JSON.stringify({ type: MSG.ERROR, message: "Unknown bot" }));
          return;
        }
        const nickname = ws.__accountPlayer?.nickname || msg.nickname;
        if (!nickname) {
          ws.send(JSON.stringify({ type: MSG.ERROR, message: "Nickname required" }));
          return;
        }
        // Same trust model as CREATE_MATCH — Match's constructor runs
        // resolveParams() on whatever's handed to it, so a tampered/stale
        // client params object can't produce an out-of-range board or clock.
        const params = msg.params ?? { mode: "classic", timeMode: "none" };
        const { match, human } = manager.createPvEMatch({
          humanNickname: nickname,
          humanAgent: ws.__agent,
          humanAccountPlayerId: ws.__accountPlayer?.id ?? null,
          botNickname: bot.nickname,
          botAccountPlayerId: bot.id,
          makeBotAgent: (m) => new BotAgent(m, chooseMoveForBotKey(botKeyFromRow(bot))),
          params,
          rated: false, // direct debug never affects rating — see docs/BOTS.md
          origin: "direct_debug",
        });
        ws.send(
          JSON.stringify({
            type: MSG.MATCH_JOINED,
            matchId: match.matchId,
            yourPlayerIndex: human.playerIndex,
            sessionId: human.sessionId,
          }),
        );
        return;
      }

      if (msg.type === MSG.MOVE_ATTEMPT) {
        const match = manager.findMatchByAgent(ws.__agent);
        if (!match) return;
        match.attemptMove(ws.__agent, msg.pieceType, msg.shape, msg.anchorRow, msg.anchorCol);
        return;
      }

      if (msg.type === MSG.PASS_ATTEMPT) {
        const match = manager.findMatchByAgent(ws.__agent);
        if (!match) return;
        match.attemptPass(ws.__agent);
        return;
      }

      // Deliberate forfeit / leave — see Match.resign / Match.leave
      // for why these are handled differently from a mere disconnect.
      if (msg.type === MSG.RESIGN) {
        const match = manager.findMatchByAgent(ws.__agent);
        if (!match) return;
        match.resign(ws.__agent);
        return;
      }

      if (msg.type === MSG.LEAVE_MATCH) {
        const match = manager.findMatchByAgent(ws.__agent);
        if (!match) return;
        match.leave(ws.__agent);
        return;
      }

      if (msg.type === MSG.REMATCH_REQUEST) {
        const match = manager.findMatchByAgent(ws.__agent);
        if (!match) return;
        match.requestRematch(ws.__agent);
        return;
      }

      // Reconnect — this ws is brand new and not yet linked to any
      // match, so we look it up by the durable sessionId instead.
      if (msg.type === MSG.RECONNECT_ATTEMPT) {
        const match = manager.findMatchBySessionId(msg.sessionId);
        if (!match || match.matchId !== msg.matchId) {
          log(`Reconnect failed: match not found (matchId=${shortId(msg.matchId)})`);
          ws.send(JSON.stringify({ type: MSG.RECONNECT_FAILED, reason: "Match not found" }));
          return;
        }
        const syncState = match.reconnect(msg.sessionId, ws.__agent);
        if (!syncState) {
          log(`Reconnect failed: session no longer valid (matchId=${shortId(msg.matchId)})`);
          ws.send(JSON.stringify({ type: MSG.RECONNECT_FAILED, reason: "Session no longer valid" }));
          return;
        }
        manager.bindAgent(ws.__agent, msg.sessionId); // Match.reconnect() operates on the Match directly, so the manager needs telling separately that this new agent now belongs to this session
        ws.send(JSON.stringify(syncState));
        return;
      }

      // hash-mismatch resync — same payload shape as reconnect, but
      // this ws is already live and attached to the match.
      if (msg.type === MSG.REQUEST_RESYNC) {
        const match = manager.findMatchByAgent(ws.__agent);
        if (!match) return;
        const player = match.players.find((p) => p.agent === ws.__agent);
        if (!player) return;
        log(`Match ${shortId(match.matchId)}: ${player.nickname} requested resync (hash mismatch)`);
        ws.send(JSON.stringify(match.buildSyncState(player)));
        return;
      }
    } catch (err) {
      console.error("handler error:", err.message);
    }
  });

  ws.on("close", () => {
    queue.leave(ws);
    const match = manager.findMatchByAgent(ws.__agent);
    if (match) match.handleDisconnect(ws.__agent);
  });
});

// heartbeat sweep, kill dead sockets, keep proxies from idle-timeout-dropping live ones
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 5000);

wss.on("close", () => clearInterval(interval));

// Re-checks waiting queue entries for pairings that have become
// acceptable purely from elapsed wait time (widening windows — see
// matchmakingQueue.js's sweep()), independent of anyone new joining.
const sweepInterval = setInterval(() => {
  const now = Date.now();
  for (const [a, b, resolvedTimeMode, rated] of queue.sweep(now)) {
    matchPair(a, b, resolvedTimeMode, rated);
  }
  // Only entries still unmatched after the human-pairing sweep above age
  // out here — human pairing always gets first chance.
  for (const [entry, resolvedTimeMode, rated, remove] of queue.expireStale(now, MATCHMAKING_BOT_FALLBACK_MS)) {
    matchBotFallback(entry, resolvedTimeMode, rated, remove);
  }
}, MATCHMAKING_SWEEP_INTERVAL_MS);

wss.on("close", () => clearInterval(sweepInterval));

httpServer.listen(8080, "127.0.0.1", () => log("Server listening on :8080"));
