import { WebSocketServer } from "ws";
import { MatchManager } from "./matchManager.js";
import { MSG } from "../js/net/protocol.js";

const wss = new WebSocketServer({ port: 8080, host: "127.0.0.1" });
const manager = new MatchManager();

function heartbeat() {
  this.isAlive = true;
}

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", heartbeat);

  // ADDED: prevent unhandled 'error' crashing whole process
  ws.on("error", (err) => {
    console.error("ws error:", err.message);
  });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
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
            sessionId: player.sessionId, // ADDED
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
            sessionId: player.sessionId, // ADDED
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

      // ADDED: deliberate forfeit / leave — see Match.resign / Match.leave
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

      // ADDED: reconnect — this ws is brand new and not yet linked to any
      // match, so we look it up by the durable sessionId instead.
      if (msg.type === MSG.RECONNECT_ATTEMPT) {
        const match = manager.findMatchBySessionId(msg.sessionId);
        if (!match || match.matchId !== msg.matchId) {
          ws.send(JSON.stringify({ type: MSG.RECONNECT_FAILED, reason: "Match not found" }));
          return;
        }
        const syncState = match.reconnect(msg.sessionId, ws);
        if (!syncState) {
          ws.send(JSON.stringify({ type: MSG.RECONNECT_FAILED, reason: "Session no longer valid" }));
          return;
        }
        ws.send(JSON.stringify(syncState));
        return;
      }

      // ADDED: hash-mismatch resync — same payload shape as reconnect, but
      // this ws is already live and attached to the match.
      if (msg.type === MSG.REQUEST_RESYNC) {
        const match = manager.findMatchByWs(ws);
        if (!match) return;
        const player = match.players.find((p) => p.ws === ws);
        if (!player) return;
        ws.send(JSON.stringify(match.buildSyncState(player)));
        return;
      }
    } catch (err) {
      // ADDED: guard against throw inside handler (e.g. send to dead opponent socket)
      console.error("handler error:", err.message);
    }
  });

  ws.on("close", () => {
    // FIXED: disconnect no longer force-removes the match — handleDisconnect
    // starts a grace-period timer and only the match itself decides when
    // it's truly done (see Match._onAbortTimeout / the onClose callback).
    const match = manager.findMatchByWs(ws);
    if (match) match.handleDisconnect(ws);
  });
});

// ADDED: heartbeat sweep, kill dead sockets, keep proxies from idle-timeout-dropping live ones
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 5000);

wss.on("close", () => clearInterval(interval));

console.log("Server listening on :8080");
