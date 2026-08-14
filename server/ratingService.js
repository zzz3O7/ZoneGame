import { getPlayerById } from "./playerRepository.js";
import { recordRatedGame } from "./gameRepository.js";
import { computeElo } from "./rating.js";
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
  const scoreP0 = winnerIndex === 0 ? 1 : winnerIndex === 1 ? 0 : 0.5;
  const [ratingAfter0, ratingAfter1] = computeElo(player0.rating, player1.rating, scoreP0);

  recordRatedGame({
    player0_id: player0.id,
    player1_id: player1.id,
    winner: winnerIndex,
    rating_before_0: player0.rating,
    rating_before_1: player1.rating,
    rating_after_0: ratingAfter0,
    rating_after_1: ratingAfter1,
    params_json: JSON.stringify(match.params),
    started_at: match._gameStartedAt ?? Date.now(),
    ended_at: Date.now(),
  });

  log(
    `Rated match ${shortId(match.matchId)}: ` +
      `${player0.nickname ?? player0.email} ${player0.rating}->${ratingAfter0}, ` +
      `${player1.nickname ?? player1.email} ${player1.rating}->${ratingAfter1}`,
  );

  // Personalized so each client just reads "my" before/after without
  // having to know its own playerIndex maps to p0 vs p1 — mirrors how the
  // endcard already frames everything as viewer-relative.
  match.broadcastPersonalized((p) => ({
    type: MSG.RATING_UPDATE,
    ratingBefore: p.playerIndex === 0 ? player0.rating : player1.rating,
    ratingAfter: p.playerIndex === 0 ? ratingAfter0 : ratingAfter1,
    opponentRatingBefore: p.playerIndex === 0 ? player1.rating : player0.rating,
    opponentRatingAfter: p.playerIndex === 0 ? ratingAfter1 : ratingAfter0,
  }));
}
