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
        const match = manager.createMatch(msg.nickname, ws, msg.params);
        ws.send(
          JSON.stringify({
            type: MSG.MATCH_CREATED,
            matchId: match.matchId,
            inviteCode: match.inviteCode,
            yourPlayerIndex: 0,
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
        ws.send(
          JSON.stringify({
            type: MSG.MATCH_JOINED,
            matchId: result.matchId,
            yourPlayerIndex: 1,
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
    // ADDED: notify opponent + cleanup, instead of TODO stub
    const match = manager.findMatchByWs(ws);
    if (match) {
      match.handleDisconnect(ws);
      manager.removeMatch(match.matchId);
    }
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
