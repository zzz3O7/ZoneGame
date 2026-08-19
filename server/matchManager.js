import { randomUUID } from "crypto";
import { Match } from "./match.js";
import { finalizeRatedGame } from "./ratingService.js";

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
    this.matchesBySessionId = new Map();
  }

  findMatchByAgent(agent) {
    return this.findMatchBySessionId(agent.__sessionId);
  }

  // The one place that ties an agent to a session. Called from
  // createMatch/joinMatch below, and by index.js after a successful
  // reconnect (a fresh agent has no properties on it yet). Agent-keyed
  // rather than ws-keyed so this works the same way once a BotAgent is a
  // real thing, even though only HumanAgents exercise this path today.
  bindAgent(agent, sessionId) {
    agent.__sessionId = sessionId;
  }

  // Used by the reconnect handshake — the incoming ws is brand new
  // and not yet linked to anything, so we can't look up by ws here.
  findMatchBySessionId(sessionId) {
    return this.matchesBySessionId.get(sessionId) || null;
  }

  // Shared construction path for every match, regardless of how its
  // players arrive (invite code vs matchmaking queue) — wires the
  // rated-game-end hook uniformly so there's exactly one place that
  // decides "does this match's outcome need scoring". matchType/origin
  // default to plain human matchmaking play — see docs/BOTS.md for the
  // other combinations, wired in as those paths get built.
  _buildMatch(params, rated, matchType = "pvp", origin = "matchmaking") {
    const matchId = randomUUID();
    let inviteCode;
    do {
      inviteCode = genInviteCode();
    } while (this.matchesByCode.has(inviteCode));

    // `match` is assigned after the Match constructor runs, but this
    // closure isn't invoked until well after that (when the game
    // actually ends), so it always sees the real match by then.
    let match;
    const onGameEnd = () => {
      if (match.rated) finalizeRatedGame(match);
    };
    match = new Match(
      matchId,
      inviteCode,
      params,
      () => this.removeMatch(matchId),
      onGameEnd,
      rated,
      matchType,
      origin,
    );

    this.matchesById.set(matchId, match);
    this.matchesByCode.set(inviteCode, match);
    return match;
  }

  createMatch(nickname, agent, params, accountPlayerId = null) {
    const match = this._buildMatch(params, false); // invite-code play is always unrated
    const player = match.addPlayer(nickname, agent, accountPlayerId);
    this.matchesBySessionId.set(player.sessionId, match);
    this.bindAgent(agent, player.sessionId);
    return { match, player };
  }

  joinMatch(inviteCode, nickname, agent, accountPlayerId = null) {
    const match = this.matchesByCode.get(inviteCode);
    if (!match) return { error: "Match not found" };
    if (match.isFull()) return { error: "Match already full" };

    const player = match.addPlayer(nickname, agent, accountPlayerId);
    this.matchesBySessionId.set(player.sessionId, match);
    this.bindAgent(agent, player.sessionId);
    return { match, player };
  }

  // Used once the matchmaking queue has paired two waiting players —
  // builds a match and seats both of them immediately, rather than
  // going through the invite-code create/join round-trip. The second
  // addPlayer() call triggers Match._start() synchronously, so both
  // players are already mid-game by the time this returns.
  createMatchForPair(playerA, playerB, params, rated) {
    const match = this._buildMatch(params, rated);
    const p0 = match.addPlayer(playerA.nickname, playerA.agent, playerA.accountPlayerId);
    const p1 = match.addPlayer(playerB.nickname, playerB.agent, playerB.accountPlayerId);
    this.matchesBySessionId.set(p0.sessionId, match);
    this.matchesBySessionId.set(p1.sessionId, match);
    this.bindAgent(playerA.agent, p0.sessionId);
    this.bindAgent(playerB.agent, p1.sessionId);
    return { match, players: [p0, p1] };
  }

  removeMatch(matchId) {
    const match = this.matchesById.get(matchId);
    if (!match) return;
    this.matchesById.delete(matchId);
    this.matchesByCode.delete(match.inviteCode);
    for (const p of match.players) this.matchesBySessionId.delete(p.sessionId);
  }
}
