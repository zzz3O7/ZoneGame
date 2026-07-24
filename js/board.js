export class Board {
  constructor(grid, bonusMarkers) {
    this.grid = grid; // 2D array: 1 = floor, 0 = wall
    this.rows = grid.length;
    this.cols = grid[0].length;
    this.cellZone = grid.map((row) => row.map(() => null)); // zone id or null
    this.occupied = new Set();
    this.bonusMarkers = bonusMarkers; // Map: key -> { claimed }
  }

  static key(row, col) {
    return `${row},${col}`;
  }

  static parse(key) {
    return key.split(",").map(Number);
  }

  isInside(row, col) {
    return row >= 0 && col >= 0 && row < this.rows && col < this.cols;
  }

  isFloor(row, col) {
    return this.isInside(row, col) && this.grid[row][col] === 1;
  }

  isOccupied(row, col) {
    return this.occupied.has(Board.key(row, col));
  }

  zoneIdAt(row, col) {
    return this.cellZone[row][col];
  }

  occupy(cells) {
    for (const [r, c] of cells) this.occupied.add(Board.key(r, c));
  }
}
