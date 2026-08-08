import { randomUUID } from "crypto";
import { Match } from "./match.js";

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
    this.matchesBySessionId = new Map(); // ADDED: durable identity -> match, for reconnect
  }

  findMatchByWs(ws) {
    // FIXED: was a linear scan over every match, then briefly stashed the
    // match itself directly on the ws (ws.__match) — but that duplicated
    // "where matches are stored" into a second place outside the manager's
    // own maps, and required remembering to clear it on removal (missing
    // that was a real bug: a still-connected player's socket could keep
    // reaching an already-removed "zombie" match). Storing just the
    // sessionId instead and routing through the SAME map reconnect already
    // uses means matchesBySessionId stays the only place a match is ever
    // actually registered — removeMatch's existing cleanup (below) is all
    // that's needed, nothing extra to remember here.
    return this.findMatchBySessionId(ws.__sessionId);
  }

  // ADDED: the one place that ties a ws to a session. Called from
  // createMatch/joinMatch below, and by index.js after a successful
  // reconnect (a fresh ws has no properties on it yet).
  bindWs(ws, sessionId) {
    ws.__sessionId = sessionId;
  }

  // ADDED: used by the reconnect handshake — the incoming ws is brand new
  // and not yet linked to anything, so we can't look up by ws here.
  findMatchBySessionId(sessionId) {
    return this.matchesBySessionId.get(sessionId) || null;
  }

  createMatch(nickname, ws, params) {
    const matchId = randomUUID();
    let inviteCode;
    do {
      inviteCode = genInviteCode();
    } while (this.matchesByCode.has(inviteCode));

    // ADDED: match tells us when it's actually done (abort timeout), instead
    // of us guessing and removing it the instant a socket drops.
    const match = new Match(matchId, inviteCode, params, () => this.removeMatch(matchId));
    const player = match.addPlayer(nickname, ws);

    this.matchesById.set(matchId, match);
    this.matchesByCode.set(inviteCode, match);
    this.matchesBySessionId.set(player.sessionId, match);
    this.bindWs(ws, player.sessionId); // ADDED
    return { match, player };
  }

  joinMatch(inviteCode, nickname, ws) {
    const match = this.matchesByCode.get(inviteCode);
    if (!match) return { error: "Match not found" };
    if (match.isFull()) return { error: "Match already full" };

    const player = match.addPlayer(nickname, ws);
    this.matchesBySessionId.set(player.sessionId, match);
    this.bindWs(ws, player.sessionId); // ADDED
    return { match, player };
  }

  removeMatch(matchId) {
    const match = this.matchesById.get(matchId);
    if (!match) return;
    this.matchesById.delete(matchId);
    this.matchesByCode.delete(match.inviteCode);
    // This is now the ONLY cleanup needed — findMatchByWs routes through
    // this same map, so deleting a player's sessionId here automatically
    // makes their ws unable to reach this match again. No separate
    // ws-side reference to remember to clear.
    for (const p of match.players) this.matchesBySessionId.delete(p.sessionId);
  }
}
