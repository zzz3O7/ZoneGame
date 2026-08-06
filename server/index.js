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
