import { randomUUID } from "crypto";
import { Match } from "./match.js";
import { finalizeRatedGame, finalizeUnratedGame } from "./ratingService.js";
import { shortId } from "./logger.js";
import { MSG } from "../shared/net/protocol.js";

// The one place that couples a live networked Match to ratingService.js's
// network-free finalize* shape — see ratingService.js's top comment for
// the other producer (bot/selfPlayScheduler.js), which builds the same
// shape directly from a bare Game, no Match involved. onRatingUpdate is
// only meaningful here (a self-play game has no client to notify).
function gameResultFromMatch(match) {
  const [p0, p1] = match.players;
  return {
    player0AccountId: p0.accountPlayerId,
    player1AccountId: p1.accountPlayerId,
    winnerIndex: match.endInfo?.winnerIndex ?? null,
    endReason: match.endInfo?.reason ?? null,
    scores: match.game.players.map((p) => p.score),
    totalBoardPoints: match.game.totalBoardPoints,
    remainingPossiblePoints: match.game.remainingPossiblePoints,
    // match.params is the pre-game config and never carries a seed — the
    // actual per-game seed (and startingPlayerIndex) only exist on
    // activeParams once the game has started, which it always has by the
    // time a game can finish. See db.js's `seed` column comment.
    seed: match.activeParams.seed,
    paramsJson: JSON.stringify(match.activeParams),
    startedAt: match._gameStartedAt,
    matchType: match.matchType,
    origin: match.origin,
    logLabel: shortId(match.matchId),
    // Personalized so each client just reads "my" before/after without
    // having to know its own playerIndex maps to p0 vs p1 — mirrors how
    // the endcard already frames everything as viewer-relative.
    onRatingUpdate: (r0, r1) =>
      match.broadcastPersonalized((p) => ({
        type: MSG.RATING_UPDATE,
        ratingBefore: p.playerIndex === 0 ? r0.ratingBefore : r1.ratingBefore,
        ratingAfter: p.playerIndex === 0 ? r0.ratingAfter : r1.ratingAfter,
        opponentRatingBefore: p.playerIndex === 0 ? r1.ratingBefore : r0.ratingBefore,
        opponentRatingAfter: p.playerIndex === 0 ? r1.ratingAfter : r0.ratingAfter,
      })),
  };
}

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
  // game-end hook uniformly so there's exactly one place that decides
  // how a finished match gets recorded: finalizeRatedGame (rating math
  // + history row) for rated matches, finalizeUnratedGame (history row
  // only, no rating math) for everything else. matchType/origin default
  // to plain human matchmaking play — see docs/BOTS.md for the other
  // combinations, wired in as those paths get built.
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
      const result = gameResultFromMatch(match);
      if (match.rated) finalizeRatedGame(result);
      else finalizeUnratedGame(result);
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

  // rated defaults to false (guest-friendly invite-code play, the common
  // case) — the caller (index.js) is responsible for having already
  // verified accountPlayerId is real whenever it passes rated=true; see
  // that handler's login/nickname checks. Only the creator's side is
  // gated here — the joiner is checked separately in joinMatch below.
  createMatch(nickname, agent, params, accountPlayerId = null, rated = false) {
    const match = this._buildMatch(params, rated);
    const player = match.addPlayer(nickname, agent, accountPlayerId);
    this.matchesBySessionId.set(player.sessionId, match);
    this.bindAgent(agent, player.sessionId);
    return { match, player };
  }

  joinMatch(inviteCode, nickname, agent, accountPlayerId = null) {
    const match = this.matchesByCode.get(inviteCode);
    if (!match) return { error: "Match not found" };
    if (match.isFull()) return { error: "Match already full" };
    // Defensive — index.js already checks this before calling in, using
    // the same rule finalizeRatedGame relies on (every rated match needs
    // a real account on both sides). Kept here too since this method's
    // contract shouldn't quietly depend on a caller upholding it elsewhere.
    if (match.rated && accountPlayerId == null) return { error: "Log in to join a rated match" };
    // Same identity check matchmakingQueue.js already applies for queued
    // pairing (see its _acceptable()) — an invite code is the other way
    // the same account could end up playing itself for rated points.
    // Two guests are both accountPlayerId === null, which must NOT count
    // as "same identity" (isFull() above already blocks a genuine
    // guest-vs-guest double-join anyway, so this only ever fires for a
    // real account matching itself).
    if (match.rated && accountPlayerId != null && match.players[0].accountPlayerId === accountPlayerId) {
      return { error: "You can't join your own rated match" };
    }

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

  // Builds a PvE match directly — no invite-code round-trip, since a bot
  // side never needs one. makeBotAgent(match) is called after the Match
  // exists but before either player is added, so BotAgent can hold a
  // real match reference from construction (see playerAgent.js — it
  // reads match.game/match.status live, not a snapshot, so it needs the
  // real thing before the _start() broadcast it reacts to even fires).
  // Only the human is bound for reconnect — a bot never disconnects, so
  // there's nothing for it to reconnect into.
  createPvEMatch({
    humanNickname,
    humanAgent,
    humanAccountPlayerId,
    botNickname,
    botAccountPlayerId,
    makeBotAgent,
    params,
    rated,
    origin,
  }) {
    const match = this._buildMatch(params, rated, "pve", origin);
    const botAgent = makeBotAgent(match);
    const human = match.addPlayer(humanNickname, humanAgent, humanAccountPlayerId);
    const bot = match.addPlayer(botNickname, botAgent, botAccountPlayerId); // triggers _start()
    this.matchesBySessionId.set(human.sessionId, match);
    this.matchesBySessionId.set(bot.sessionId, match);
    this.bindAgent(humanAgent, human.sessionId);
    return { match, human, bot };
  }

  // Read-only introspection for the admin tool — every live match,
  // regardless of status. Callers should treat these as a snapshot, not
  // hold onto them across ticks.
  listMatches() {
    return [...this.matchesById.values()];
  }

  getMatch(matchId) {
    return this.matchesById.get(matchId) || null;
  }

  removeMatch(matchId) {
    const match = this.matchesById.get(matchId);
    if (!match) return;
    this.matchesById.delete(matchId);
    this.matchesByCode.delete(match.inviteCode);
    for (const p of match.players) this.matchesBySessionId.delete(p.sessionId);
  }
}
