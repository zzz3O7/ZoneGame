import { getPlayerById } from "./playerRepository.js";
import { recordRatedGame, recordUnratedGame } from "./gameRepository.js";
import { computeBinaryUpdate, computeMarginModifier, applyInactivityRegrowth } from "./rating.js";
import { log, shortId } from "./logger.js";
import { MSG } from "../shared/net/protocol.js";

// Called once, right after a rated match's status/endInfo have already
// been set to a final result (see Match._logMatchEnd — this fires from
// every game-ending path: no-moves, resign, timeout, abort). Guests
// can't reach a rated match at all (enforced at queue-join time, and at
// CREATE_MATCH/JOIN_MATCH time for invite-code play — see index.js),
// so both players should always have an accountPlayerId here — the
// checks below are defensive, not expected to trigger in normal play.
export function finalizeRatedGame(match) {
  const [p0, p1] = match.players;
  if (p0.accountPlayerId == null || p1.accountPlayerId == null) {
    console.error(`Rated match ${match.matchId} has a player with no account id — skipping rating update`);
    return;
  }

  const player0 = getPlayerById(p0.accountPlayerId);
  const player1 = getPlayerById(p1.accountPlayerId);
  if (!player0 || !player1) {
    console.error(`Rated match ${match.matchId}: player row missing — skipping rating update`);
    return;
  }

  const winnerIndex = match.endInfo?.winnerIndex ?? null;
  const endReason = match.endInfo?.reason ?? null;
  const scoreP0 = winnerIndex === 0 ? 1 : winnerIndex === 1 ? 0 : 0.5;

  let [rawScore0, rawScore1] = match.game.players.map((p) => p.score);
  const totalBoardPoints = match.game.totalBoardPoints;
  const remainingPossiblePoints = match.game.remainingPossiblePoints;

  const muBefore0 = player0.rating_mu;
  const muBefore1 = player1.rating_mu;

  // Widen sigma for time away since each player's last rated game before
  // using it — this is the only place inactivity regrowth applies. The
  // regrown value becomes this game's real "before" state, both for the
  // update math and for what gets stored in history.
  const endedAt = Date.now();
  const sigmaBefore0 = applyInactivityRegrowth(player0.rating_sigma, player0.last_rated_game_at, endedAt);
  const sigmaBefore1 = applyInactivityRegrowth(player1.rating_sigma, player1.last_rated_game_at, endedAt);

  // Layer 1: margin-blind binary update — this is the only thing that
  // moves sigma, and the only source of the "raw" mu delta. Performance
  // variance is TAU_GLOBAL now (a fixed constant inside rating.js), not
  // passed in here — see that constant's comment for why per-player
  // tau estimation was removed.
  const binary = computeBinaryUpdate({
    muA: muBefore0,
    sigmaA: sigmaBefore0,
    muB: muBefore1,
    sigmaB: sigmaBefore1,
    scoreA: scoreP0,
  });

  // Layer 2: small capped cosmetic modifier on the visible mu delta.
  // Every ending produces a margin now — normalized by the board's total
  // capacity, a truncated game naturally reads as a small, honest margin
  // rather than needing an endReason check to be excluded. This is
  // margin's only remaining consumer. Resign no longer inflates this with
  // the still-contestable points — margin reflects the board as it
  // actually stood when the game ended, resign included.
  const { modifier, margin } = computeMarginModifier(rawScore0, rawScore1, totalBoardPoints);

  const muAfter0 = muBefore0 + binary.muDeltaA * modifier;
  const muAfter1 = muBefore1 + binary.muDeltaB * modifier;
  const sigmaAfter0 = binary.sigmaAfterA;
  const sigmaAfter1 = binary.sigmaAfterB;

  const ratingBefore0 = Math.round(muBefore0);
  const ratingBefore1 = Math.round(muBefore1);
  const ratingAfter0 = Math.round(muAfter0);
  const ratingAfter1 = Math.round(muAfter1);

  recordRatedGame({
    player0_id: player0.id,
    player1_id: player1.id,
    winner: winnerIndex,
    score_0: rawScore0,
    score_1: rawScore1,
    end_reason: endReason,
    margin,
    remaining_possible_points: remainingPossiblePoints,
    total_board_points: totalBoardPoints,
    mu_before_0: muBefore0,
    sigma_before_0: sigmaBefore0,
    mu_after_0: muAfter0,
    sigma_after_0: sigmaAfter0,
    mu_before_1: muBefore1,
    sigma_before_1: sigmaBefore1,
    mu_after_1: muAfter1,
    sigma_after_1: sigmaAfter1,
    // match.params is the pre-game config and never carries a seed —
    // the actual per-game seed (and startingPlayerIndex) only exist on
    // activeParams once the game has started, which it always has by
    // the time a game can finish. See db.js's `seed` column comment.
    seed: match.activeParams.seed,
    params_json: JSON.stringify(match.activeParams),
    started_at: match._gameStartedAt ?? endedAt,
    ended_at: endedAt,
    match_type: match.matchType,
    origin: match.origin,
  });

  log(
    `Rated match ${shortId(match.matchId)}: ` +
      `${player0.nickname ?? player0.email} ${ratingBefore0}->${ratingAfter0}, ` +
      `${player1.nickname ?? player1.email} ${ratingBefore1}->${ratingAfter1} ` +
      `(${endReason}, margin=${margin.toFixed(2)}, mod=${modifier.toFixed(3)}, remaining=${remainingPossiblePoints}/${totalBoardPoints})`,
  );

  // Personalized so each client just reads "my" before/after without
  // having to know its own playerIndex maps to p0 vs p1 — mirrors how the
  // endcard already frames everything as viewer-relative.
  match.broadcastPersonalized((p) => ({
    type: MSG.RATING_UPDATE,
    ratingBefore: p.playerIndex === 0 ? ratingBefore0 : ratingBefore1,
    ratingAfter: p.playerIndex === 0 ? ratingAfter0 : ratingAfter1,
    opponentRatingBefore: p.playerIndex === 0 ? ratingBefore1 : ratingBefore0,
    opponentRatingAfter: p.playerIndex === 0 ? ratingAfter1 : ratingAfter0,
  }));
}

// Called once, right after an UNRATED match's status/endInfo have
// already been set to a final result — same trigger points as
// finalizeRatedGame (every game-ending path, only when a game actually
// started). Saves the game to history for admin visibility, but runs
// no rating math at all: rating_mu/sigma/games_played on either player
// row are left completely untouched, and every mu/sigma column on the
// stored row is null (there's nothing to snapshot — see
// recordUnratedGame in gameRepository.js).
//
// Unlike rated matches, a player here can be a guest (accountPlayerId
// == null) — that's allowed by design for unrated play. Whenever a
// side IS logged in, though, their real player id is stored (not
// null), specifically so their unrated games still show up under their
// own admin player-detail history alongside their rated ones.
export function finalizeUnratedGame(match) {
  const [p0, p1] = match.players;
  const winnerIndex = match.endInfo?.winnerIndex ?? null;
  const endReason = match.endInfo?.reason ?? null;
  const [rawScore0, rawScore1] = match.game.players.map((p) => p.score);
  const totalBoardPoints = match.game.totalBoardPoints;
  const remainingPossiblePoints = match.game.remainingPossiblePoints;

  // Margin is a pure function of the scores (see rating.js) — still
  // worth storing here for the same "self-explaining history" reason
  // rated games store it, even though no modifier ever gets applied to
  // anything for an unrated game.
  const { margin } = computeMarginModifier(rawScore0, rawScore1, totalBoardPoints);

  recordUnratedGame({
    player0_id: p0.accountPlayerId ?? null,
    player1_id: p1.accountPlayerId ?? null,
    winner: winnerIndex,
    score_0: rawScore0,
    score_1: rawScore1,
    end_reason: endReason,
    margin,
    remaining_possible_points: remainingPossiblePoints,
    total_board_points: totalBoardPoints,
    mu_before_0: null,
    sigma_before_0: null,
    mu_after_0: null,
    sigma_after_0: null,
    mu_before_1: null,
    sigma_before_1: null,
    mu_after_1: null,
    sigma_after_1: null,
    seed: match.activeParams.seed,
    params_json: JSON.stringify(match.activeParams),
    started_at: match._gameStartedAt ?? Date.now(),
    ended_at: Date.now(),
    match_type: match.matchType,
    origin: match.origin,
  });
}
