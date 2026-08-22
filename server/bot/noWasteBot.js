import { Rules } from "../../shared/engine/rules.js";

// Tier 2: same uniform-random choice as randomBotMove, but never spends a
// domino unless every other piece type has zero legal placements right now.
// The domino is a scarce, match-wide resource — see docs/GDD_ZoneGame.md
// section 7 — so a bot that burns them on moves a tromino/tetromino could
// have made instead is throwing away its own late-game scalpel for free.
// This alone is a real strength gain over pure random play, with no
// evaluation of the resulting position required.
//
// Signature matches what BotAgent expects: (game, playerIndex) -> move
// shaped like { pieceType, shape, anchorRow, anchorCol }, or null to pass.
export function noWasteBotMove(game, playerIndex) {
  const player = game.players[playerIndex];
  const moves = Rules.allLegalPlacements(game.board, game.zones, player);
  if (moves.length === 0) return null;

  const nonDomino = moves.filter((move) => move.pieceType !== "domino");
  const pool = nonDomino.length > 0 ? nonDomino : moves;
  return pool[Math.floor(Math.random() * pool.length)];
}
