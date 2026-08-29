import { getPlayerById } from "./playerRepository.js";
import { recordRatedGame, recordUnratedGame } from "./gameRepository.js";
import { computeBinaryUpdate, computeMarginModifier, applyInactivityRegrowth, ratingWeightForMatchType } from "./rating.js";
import { log } from "./logger.js";

// finalizeRatedGame/finalizeUnratedGame take a plain, already-finished
// game result — no dependency on Match, WebSockets, or any other
// networking/orchestration concept. That's deliberate: it's what lets a
// live networked Match (matchManager.js) and the headless self-play
// scheduler (bot/selfPlayScheduler.js, see docs/BOTS.md Phase 3) feed
// the exact same rating pipeline, even though the scheduler never builds
// a Match at all. matchManager.js's onGameEnd is the one place that
// translates a real Match into this shape; selfPlayScheduler.js builds
// it directly from a bare Game.
//
// Shape (both functions):
//   player0AccountId, player1AccountId  real players-table ids (rated:
//                                       never null; unrated: null allowed for a guest)
//   winnerIndex        0 | 1 | null (draw)
//   endReason          stored as-is, e.g. "no-moves" | "resign" | "timeout" | "abort"
//   scores             [rawScore0, rawScore1]
//   totalBoardPoints, remainingPossiblePoints
//   seed, paramsJson   for history/replay
//   startedAt, endedAt epoch ms (endedAt defaults to Date.now())
//   matchType          'pvp' | 'pve' | 'eve' — also selects the rating
//                       weight for a rated game, see rating.js
//   origin             stored as-is, e.g. 'matchmaking' | 'direct_debug' | 'self_play_scheduler'
//   logLabel           short id for the log line (finalizeRatedGame only)
//   onRatingUpdate     optional (result0, result1) => void, each result
//                       is { ratingBefore, ratingAfter } (finalizeRatedGame only)

// Called once, right after a rated game's result is final — from every
// game-ending path a producer has (a live Match's no-moves/resign/
// timeout/abort, or a self-play game's natural no-moves end). Guests
// can't reach a rated match at all (enforced at queue-join/CREATE_MATCH/
// JOIN_MATCH time — see index.js) and self-play only ever pairs real bot
// rows, so both account ids should always be present here — the check
// below is defensive, not expected to trigger in normal play.
export function finalizeRatedGame({
  player0AccountId,
  player1AccountId,
  winnerIndex,
  endReason,
  scores,
  totalBoardPoints,
  remainingPossiblePoints,
  seed,
  paramsJson,
  startedAt,
  endedAt = Date.now(),
  matchType,
  origin,
  logLabel = "-",
  onRatingUpdate,
}) {
  if (player0AccountId == null || player1AccountId == null) {
    console.error(`Rated game ${logLabel} has a player with no account id — skipping rating update`);
    return;
  }

  const player0 = getPlayerById(player0AccountId);
  const player1 = getPlayerById(player1AccountId);
  if (!player0 || !player1) {
    console.error(`Rated game ${logLabel}: player row missing — skipping rating update`);
    return;
  }

  const scoreP0 = winnerIndex === 0 ? 1 : winnerIndex === 1 ? 0 : 0.5;
  const [rawScore0, rawScore1] = scores;

  const muBefore0 = player0.rating_mu;
  const muBefore1 = player1.rating_mu;

  // Widen sigma for time away since each player's last rated game before
  // using it — this is the only place inactivity regrowth applies. The
  // regrown value becomes this game's real "before" state, both for the
  // update math and for what gets stored in history.
  const sigmaBefore0 = applyInactivityRegrowth(player0.rating_sigma, player0.last_rated_game_at, endedAt);
  const sigmaBefore1 = applyInactivityRegrowth(player1.rating_sigma, player1.last_rated_game_at, endedAt);

  // Layer 1: margin-blind binary update — the only source of the "raw"
  // mu delta and sigma shrinkage. Performance variance is TAU_GLOBAL now
  // (a fixed constant inside rating.js), not passed in here — see that
  // constant's comment for why per-player tau estimation was removed.
  const binary = computeBinaryUpdate({
    muA: muBefore0,
    sigmaA: sigmaBefore0,
    muB: muBefore1,
    sigmaB: sigmaBefore1,
    scoreA: scoreP0,
  });

  // Layer 2: small capped cosmetic modifier on the visible mu delta,
  // from how decisive the score margin was.
  const { modifier, margin } = computeMarginModifier(rawScore0, rawScore1, totalBoardPoints);

  // Layer 3: match_type-based rating weight (see rating.js). Blended
  // toward "no update at all" rather than a flat multiplier on mu alone,
  // so a weight below 1 dampens BOTH the mu delta and the sigma
  // shrinkage together — weight=1 must be an exact no-op against the
  // unweighted math (every pvp/pve game today), which is what makes this
  // safe to have added without touching the update math itself.
  const weight = ratingWeightForMatchType(matchType);
  const muAfter0 = muBefore0 + binary.muDeltaA * modifier * weight;
  const muAfter1 = muBefore1 + binary.muDeltaB * modifier * weight;
  const sigmaAfter0 = sigmaBefore0 + (binary.sigmaAfterA - sigmaBefore0) * weight;
  const sigmaAfter1 = sigmaBefore1 + (binary.sigmaAfterB - sigmaBefore1) * weight;

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
    seed,
    params_json: paramsJson,
    started_at: startedAt ?? endedAt,
    ended_at: endedAt,
    match_type: matchType,
    origin,
  });

  log(
    `Rated game ${logLabel}: ` +
      `${player0.nickname ?? player0.email} ${ratingBefore0}->${ratingAfter0}, ` +
      `${player1.nickname ?? player1.email} ${ratingBefore1}->${ratingAfter1} ` +
      `(${endReason}, margin=${margin.toFixed(2)}, mod=${modifier.toFixed(3)}` +
      (weight !== 1 ? `, weight=${weight}` : "") +
      `, remaining=${remainingPossiblePoints}/${totalBoardPoints})`,
  );

  if (onRatingUpdate) {
    onRatingUpdate(
      { ratingBefore: ratingBefore0, ratingAfter: ratingAfter0 },
      { ratingBefore: ratingBefore1, ratingAfter: ratingAfter1 },
    );
  }
}

// Called once, right after an UNRATED game's result is final — same
// trigger points as finalizeRatedGame. Saves the game to history for
// admin visibility, but runs no rating math at all: rating_mu/sigma/
// games_played on either player row are left completely untouched, and
// every mu/sigma column on the stored row is null (there's nothing to
// snapshot — see recordUnratedGame in gameRepository.js).
//
// Unlike a rated game, a side here can be a guest (accountPlayerId ==
// null) — that's allowed by design for unrated play. Whenever a side IS
// logged in, though, their real player id is stored (not null),
// specifically so their unrated games still show up under their own
// admin player-detail history alongside their rated ones.
export function finalizeUnratedGame({
  player0AccountId = null,
  player1AccountId = null,
  winnerIndex,
  endReason,
  scores,
  totalBoardPoints,
  remainingPossiblePoints,
  seed,
  paramsJson,
  startedAt,
  endedAt = Date.now(),
  matchType,
  origin,
}) {
  const [rawScore0, rawScore1] = scores;

  // Margin is a pure function of the scores (see rating.js) — still
  // worth storing here for the same "self-explaining history" reason a
  // rated game stores it, even though no modifier ever gets applied to
  // anything for an unrated game.
  const { margin } = computeMarginModifier(rawScore0, rawScore1, totalBoardPoints);

  recordUnratedGame({
    player0_id: player0AccountId,
    player1_id: player1AccountId,
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
    seed,
    params_json: paramsJson,
    started_at: startedAt ?? endedAt,
    ended_at: endedAt,
    match_type: matchType,
    origin,
  });
}
