import { WebSocketServer } from "ws";
import { MatchManager } from "./MatchManager.js";
import { MSG } from "../js/protocol.js";

const wss = new WebSocketServer({ port: 8080 });
const manager = new MatchManager();

wss.on("connection", (ws) => {
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === MSG.CREATE_MATCH) {
      const match = manager.createMatch(msg.nickname, ws);
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
      return; // Match.addPlayer already triggered broadcast internally
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
  });

  ws.on("close", () => {
    // TODO handle disconnect/reconnect
  });
});

console.log("Server listening on :8080");
