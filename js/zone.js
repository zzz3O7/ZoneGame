import { Board } from "./board.js";

export class Zone {
  constructor(id, cellSet, cost, creator) {
    this.id = id;
    this.cellSet = cellSet;
    this.cost = cost;
    this.active = true;
    this.creator = creator;
    this.localTurn = 1 - creator;
  }

  complete() {
    this.active = false;
  }

  static floodFill(board, startRow, startCol, radius) {
    const cellSet = new Set();
    if (!board.isFloor(startRow, startCol)) return cellSet;

    const visited = new Set([Board.key(startRow, startCol)]);
    const queue = [[startRow, startCol]];

    while (queue.length) {
      const [r, c] = queue.shift();
      const dist = Math.max(Math.abs(r - startRow), Math.abs(c - startCol));
      if (dist > radius) continue;
      if (board.zoneIdAt(r, c) !== null) continue;

      cellSet.add(Board.key(r, c));

      for (const [dr, dc] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const nr = r + dr,
          nc = c + dc;
        const key = Board.key(nr, nc);
        if (!board.isFloor(nr, nc)) continue;
        if (visited.has(key)) continue;
        visited.add(key);
        queue.push([nr, nc]);
      }
    }
    return cellSet;
  }

  static bonusesInRange(board, cellSet, anchorRow, anchorCol, radius) {
    const found = new Set();
    for (const key of board.bonusMarkers.keys()) {
      if (board.bonusMarkers.get(key).claimed) continue;
      const [r, c] = Board.parse(key);
      const dist = Math.max(Math.abs(r - anchorRow), Math.abs(c - anchorCol));
      if (dist > radius) continue;

      const adjacentToZone = [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ].some(([dr, dc]) => cellSet.has(Board.key(r + dr, c + dc)));
      if (adjacentToZone) found.add(key);
    }
    return found;
  }

  static create(board, zones, anchorRow, anchorCol, creator, radius) {
    const id = zones.length;
    const cellSet = Zone.floodFill(board, anchorRow, anchorCol, radius);
    const bonusKeys = Zone.bonusesInRange(board, cellSet, anchorRow, anchorCol, radius);

    for (const key of bonusKeys) board.bonusMarkers.get(key).claimed = true;

    const cost = cellSet.size + bonusKeys.size * 5;
    for (const key of cellSet) {
      const [r, c] = Board.parse(key);
      board.cellZone[r][c] = id;
    }

    const zone = new Zone(id, cellSet, cost, creator);
    zones.push(zone);
    return zone;
  }
}
