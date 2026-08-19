import { Rules } from "../../shared/engine/rules.js";

// Phase 1's only strength tier: uniformly random among all legal moves.
// Deliberately dumb — this phase is about proving the pipeline (agent
// wiring, matchmaking fallback, timing, rating), not bot strength.
// See docs/BOTS.md Phase 2 for real position evaluation.
//
// Signature matches what BotAgent expects: (game, playerIndex) -> move
// shaped like { pieceType, shape, anchorRow, anchorCol }, or null to pass.
export function randomBotMove(game, playerIndex) {
  const player = game.players[playerIndex];
  const moves = Rules.allLegalPlacements(game.board, game.zones, player);
  if (moves.length === 0) return null;
  return moves[Math.floor(Math.random() * moves.length)];
}
