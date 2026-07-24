import { Board } from "./board.js";
import { Shape, SHAPE_VARIANTS } from "./shape.js";

export class Rules {
  static isValidPlacement(board, shape, anchorRow, anchorCol) {
    return Shape.cellsAt(shape, anchorRow, anchorCol).every(([r, c]) => {
      if (!board.isInside(r, c)) return false;
      if (!board.isFloor(r, c)) return false;
      if (board.isOccupied(r, c)) return false;
      return true;
    });
  }

  static canPlaceHere(board, zones, player, pieceType, shape, anchorRow, anchorCol) {
    if (pieceType === "domino" && player.dominoLeft <= 0) return false;
    if (!Rules.isValidPlacement(board, shape, anchorRow, anchorCol)) return false;

    const cells = Shape.cellsAt(shape, anchorRow, anchorCol);
    const zoneIds = new Set(cells.map(([r, c]) => board.zoneIdAt(r, c)));
    if (zoneIds.size > 1) return false;

    const zoneId = [...zoneIds][0];
    if (zoneId === null) return true;

    const zone = zones[zoneId];
    return zone.active && zone.localTurn === player.id;
  }

  static zoneHasMove(board, zones, zone, player) {
    const availableTypes = player.availableTypes();
    for (const type of availableTypes) {
      for (const shape of SHAPE_VARIANTS[type]) {
        for (const key of zone.cellSet) {
          if (board.occupied.has(key)) continue;
          const [r, c] = Board.parse(key);
          if (Rules.canPlaceHere(board, zones, player, type, shape, r, c)) return true;
        }
      }
    }
    return false;
  }

  static canPlayerMove(board, zones, player) {
    const availableTypes = player.availableTypes();
    for (let r = 0; r < board.rows; r++) {
      for (let c = 0; c < board.cols; c++) {
        if (!board.isFloor(r, c)) continue;
        for (const type of availableTypes) {
          for (const shape of SHAPE_VARIANTS[type]) {
            if (Rules.canPlaceHere(board, zones, player, type, shape, r, c)) return true;
          }
        }
      }
    }
    return false;
  }
}
