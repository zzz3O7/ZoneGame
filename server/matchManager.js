import { randomUUID } from "crypto";
import { Match } from "./Match.js";

function genInviteCode() {
  // 6 char, readable alphabet (no 0/O/1/I confusion)
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

export class MatchManager {
  constructor() {
    this.matchesById = new Map();
    this.matchesByCode = new Map();
  }

  findMatchByWs(ws) {
    // TODO replace with match by player map
    for (const match of this.matchesById.values()) {
      if (match.players.some((p) => p.ws === ws)) return match;
    }
    return null;
  }

  createMatch(nickname, ws) {
    const matchId = randomUUID();
    let inviteCode;
    do {
      inviteCode = genInviteCode();
    } while (this.matchesByCode.has(inviteCode));

    const match = new Match(matchId, inviteCode);
    match.addPlayer(nickname, ws);

    this.matchesById.set(matchId, match);
    this.matchesByCode.set(inviteCode, match);
    return match;
  }

  joinMatch(inviteCode, nickname, ws) {
    const match = this.matchesByCode.get(inviteCode);
    if (!match) return { error: "Match not found" };
    if (match.isFull()) return { error: "Match already full" };

    match.addPlayer(nickname, ws);
    return match;
  }

  removeMatch(matchId) {
    const match = this.matchesById.get(matchId);
    if (!match) return;
    this.matchesById.delete(matchId);
    this.matchesByCode.delete(match.inviteCode);
  }
}
