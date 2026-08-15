import { getPlayerById } from "./playerRepository.js";
import { recordRatedGame } from "./gameRepository.js";
import { computeBinaryUpdate, computeMarginModifier, updateTau, applyInactivityRegrowth } from "./rating.js";
import { log, shortId } from "./logger.js";
import { MSG } from "../shared/net/protocol.js";

// Called once, right after a rated match's status/endInfo have already
// been set to a final result (see Match._logMatchEnd — this fires from
// every game-ending path: no-moves, resign, timeout, abort). Guests
// can't reach a rated match at all (enforced at queue-join time), so
// both players should always have an accountPlayerId here — the checks
// below are defensive, not expected to trigger in normal play.
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
  const [rawScore0, rawScore1] = match.game.players.map((p) => p.score);

  const muBefore0 = player0.rating_mu,
    tauBefore0 = player0.rating_tau;
  const muBefore1 = player1.rating_mu,
    tauBefore1 = player1.rating_tau;

  // Widen sigma for time away since each player's last rated game before
  // using it — this is the only place inactivity regrowth applies. The
  // regrown value becomes this game's real "before" state, both for the
  // update math and for what gets stored in history.
  const endedAt = Date.now();
  const sigmaBefore0 = applyInactivityRegrowth(player0.rating_sigma, player0.last_rated_game_at, endedAt);
  const sigmaBefore1 = applyInactivityRegrowth(player1.rating_sigma, player1.last_rated_game_at, endedAt);

  // Layer 1: margin-blind binary update — this is the only thing that
  // moves sigma, and the only source of the "raw" mu delta.
  const binary = computeBinaryUpdate({
    muA: muBefore0,
    sigmaA: sigmaBefore0,
    tauA: tauBefore0,
    muB: muBefore1,
    sigmaB: sigmaBefore1,
    tauB: tauBefore1,
    scoreA: scoreP0,
  });

  // Layer 2: small capped cosmetic modifier on the visible mu delta.
  const { modifier, marginApplied, margin } = computeMarginModifier(rawScore0, rawScore1, endReason);

  const muAfter0 = muBefore0 + binary.muDeltaA * modifier;
  const muAfter1 = muBefore1 + binary.muDeltaB * modifier;
  const sigmaAfter0 = binary.sigmaAfterA;
  const sigmaAfter1 = binary.sigmaAfterB;

  // Layer 3: tau EWMA, fed the raw unclamped margin — only when one exists.
  let tauAfter0 = tauBefore0,
    tauAfter1 = tauBefore1;
  if (marginApplied) {
    const tau = updateTau({
      tauA: tauBefore0,
      tauB: tauBefore1,
      muA: muBefore0,
      muB: muBefore1,
      sigmaA: sigmaBefore0,
      sigmaB: sigmaBefore1,
      margin,
    });
    tauAfter0 = tau.tauAfterA;
    tauAfter1 = tau.tauAfterB;
  }

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
    margin_applied: marginApplied ? 1 : 0,
    mu_before_0: muBefore0,
    sigma_before_0: sigmaBefore0,
    tau_before_0: tauBefore0,
    mu_after_0: muAfter0,
    sigma_after_0: sigmaAfter0,
    tau_after_0: tauAfter0,
    mu_before_1: muBefore1,
    sigma_before_1: sigmaBefore1,
    tau_before_1: tauBefore1,
    mu_after_1: muAfter1,
    sigma_after_1: sigmaAfter1,
    tau_after_1: tauAfter1,
    params_json: JSON.stringify(match.params),
    started_at: match._gameStartedAt ?? endedAt,
    ended_at: endedAt,
  });

  log(
    `Rated match ${shortId(match.matchId)}: ` +
      `${player0.nickname ?? player0.email} ${ratingBefore0}->${ratingAfter0}, ` +
      `${player1.nickname ?? player1.email} ${ratingBefore1}->${ratingAfter1}` +
      (marginApplied ? ` (margin=${margin.toFixed(2)}, mod=${modifier.toFixed(3)})` : ` (${endReason}, no margin)`),
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
