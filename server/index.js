import http from "http";
import { WebSocketServer } from "ws";
import { MatchManager } from "./matchManager.js";
import { MSG } from "../shared/net/protocol.js";
import { log, shortId } from "./logger.js";
import { handleAuthRequest } from "./authRoutes.js";
import { serveStatic } from "./staticServer.js";

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

function heartbeat() {
  this.isAlive = true;
}

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", heartbeat);

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
        const { match, player } = manager.createMatch(msg.nickname, ws, msg.params);
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
        const result = manager.joinMatch(msg.inviteCode, msg.nickname, ws);
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
