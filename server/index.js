import http from "http";
import { WebSocketServer } from "ws";
import { MatchManager } from "./matchManager.js";
import { MSG } from "../shared/net/protocol.js";
import { log, shortId } from "./logger.js";
import { handleAuthRequest } from "./authRoutes.js";
import { serveStatic } from "./staticServer.js";
import { readSessionCookie } from "./cookies.js";
import { getSessionPlayer } from "./sessionStore.js";
import { MatchmakingQueue } from "./matchmakingQueue.js";

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

function heartbeat() {
  this.isAlive = true;
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
        const { match, player } = manager.createMatch(msg.nickname, ws, msg.params, ws.__accountPlayer?.id ?? null);
        ws.send(
          JSON.stringify({
            type: MSG.MATCH_CREATED,
            matchId: match.matchId,
            inviteCode: match.inviteCode,
            yourPlayerIndex: player.playerIndex,
            sessionId: player.sessionId,
          }),
        );
        return;
      }

      if (msg.type === MSG.JOIN_MATCH) {
        const result = manager.joinMatch(msg.inviteCode, msg.nickname, ws, ws.__accountPlayer?.id ?? null);
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

        // Rated always uses the account's own nickname (never a
        // client-supplied one); unrated matchmaking accepts guests, so
        // it takes whatever nickname the client sent, same as invite-code play.
        const nickname = rated ? ws.__accountPlayer.nickname : msg.nickname;
        if (!nickname) {
          ws.send(JSON.stringify({ type: MSG.ERROR, message: "Nickname required" }));
          return;
        }

        const entry = { nickname, accountPlayerId: ws.__accountPlayer?.id ?? null, params: msg.params };
        const pair = queue.join(ws, entry, rated);
        if (!pair) {
          ws.send(JSON.stringify({ type: MSG.QUEUED }));
          return;
        }

        const [a, b] = pair;
        const { match, players } = manager.createMatchForPair(a, b, a.params, rated);
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
        return;
      }

      if (msg.type === MSG.LEAVE_QUEUE) {
        queue.leave(ws);
        ws.send(JSON.stringify({ type: MSG.QUEUE_CANCELLED }));
        return;
      }

      if (msg.type === MSG.MOVE_ATTEMPT) {
        const match = manager.findMatchByWs(ws);
        if (!match) return;
        match.attemptMove(ws, msg.pieceType, msg.shape, msg.anchorRow, msg.anchorCol);
        return;
      }

      if (msg.type === MSG.PASS_ATTEMPT) {
        const match = manager.findMatchByWs(ws);
        if (!match) return;
        match.attemptPass(ws);
        return;
      }

      // Deliberate forfeit / leave — see Match.resign / Match.leave
      // for why these are handled differently from a mere disconnect.
      if (msg.type === MSG.RESIGN) {
        const match = manager.findMatchByWs(ws);
        if (!match) return;
        match.resign(ws);
        return;
      }

      if (msg.type === MSG.LEAVE_MATCH) {
        const match = manager.findMatchByWs(ws);
        if (!match) return;
        match.leave(ws);
        return;
      }

      if (msg.type === MSG.REMATCH_REQUEST) {
        const match = manager.findMatchByWs(ws);
        if (!match) return;
        match.requestRematch(ws);
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
        const syncState = match.reconnect(msg.sessionId, ws);
        if (!syncState) {
          log(`Reconnect failed: session no longer valid (matchId=${shortId(msg.matchId)})`);
          ws.send(JSON.stringify({ type: MSG.RECONNECT_FAILED, reason: "Session no longer valid" }));
          return;
        }
        manager.bindWs(ws, msg.sessionId); // Match.reconnect() operates on the Match directly, so the manager needs telling separately that this new ws now belongs to this session
        ws.send(JSON.stringify(syncState));
        return;
      }

      // hash-mismatch resync — same payload shape as reconnect, but
      // this ws is already live and attached to the match.
      if (msg.type === MSG.REQUEST_RESYNC) {
        const match = manager.findMatchByWs(ws);
        if (!match) return;
        const player = match.players.find((p) => p.ws === ws);
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
    const match = manager.findMatchByWs(ws);
    if (match) match.handleDisconnect(ws);
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

httpServer.listen(8080, "127.0.0.1", () => log("Server listening on :8080"));
