import { shuffle } from "./rng.js";

export class CaveGenerator {
  static randomFill(rows, cols, fillProb, rng = Math.random) {
    const g = [];
    for (let row = 0; row < rows; row++) {
      const gridRow = [];
      for (let col = 0; col < cols; col++) {
        gridRow.push(rng() < fillProb ? 0 : 1);
      }
      g.push(gridRow);
    }
    return g;
  }

  static countWallNeighbors(g, row, col) {
    let count = 0;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const r = row + dr,
          c = col + dc;
        if (r < 0 || c < 0 || r >= g.length || c >= g[0].length || g[r][c] === 0) count++;
      }
    }
    return count;
  }

  static smooth(g) {
    const rows = g.length,
      cols = g[0].length;
    const ng = g.map((row) => row.slice());
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        ng[row][col] = CaveGenerator.countWallNeighbors(g, row, col) >= 5 ? 0 : 1;
      }
    }
    return ng;
  }

  static removeIsolatedBorderWalls(g) {
    const rows = g.length,
      cols = g[0].length;
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const isBorder = row === 0 || col === 0 || row === rows - 1 || col === cols - 1;
        if (isBorder && g[row][col] === 0 && CaveGenerator.countWallNeighbors(g, row, col) === 3) {
          g[row][col] = 1;
        }
      }
    }
    return g;
  }

  static findRegions(g) {
    const rows = g.length,
      cols = g[0].length;
    const visited = g.map((row) => row.map(() => false));
    const regions = [];

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        if (g[row][col] === 1 && !visited[row][col]) {
          const region = [];
          const stack = [[row, col]];
          visited[row][col] = true;

          while (stack.length) {
            const [r, c] = stack.pop();
            region.push([r, c]);
            for (const [dr, dc] of [
              [1, 0],
              [-1, 0],
              [0, 1],
              [0, -1],
            ]) {
              const nr = r + dr,
                nc = c + dc;
              if (nr >= 0 && nc >= 0 && nr < rows && nc < cols && g[nr][nc] === 1 && !visited[nr][nc]) {
                visited[nr][nc] = true;
                stack.push([nr, nc]);
              }
            }
          }
          regions.push(region);
        }
      }
    }
    return regions;
  }

  static removeSmallRegions(g, minSize) {
    const regions = CaveGenerator.findRegions(g);
    for (const region of regions) {
      if (region.length <= minSize) {
        for (const [r, c] of region) g[r][c] = 0;
      }
    }
    return g;
  }

  static floorRatio(g) {
    let floor = 0,
      total = 0;
    for (const row of g) {
      for (const cell of row) {
        total++;
        if (cell === 1) floor++;
      }
    }
    return floor / total;
  }

  static generate(
    rows,
    cols,
    fillProb = 0.6,
    rng = Math.random,
    smoothIter = 3,
    minRatio = 0.4,
    maxRatio = 0.6,
    maxAttempts = 30,
  ) {
    let g;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      g = CaveGenerator.randomFill(rows, cols, fillProb, rng);
      for (let i = 0; i < smoothIter; i++) g = CaveGenerator.smooth(g);
      g = CaveGenerator.removeIsolatedBorderWalls(g);
      g = CaveGenerator.removeSmallRegions(g, 10);

      const ratio = CaveGenerator.floorRatio(g);
      if (ratio >= minRatio && ratio <= maxRatio) {
        console.log(`Generated a board in ${attempt + 1} attempts`);
        return g;
      }
    }
    console.warn(`Unable to generate a good board in ${maxAttempts} attempts`);
    return g;
  }

  static placeBonusMarkers(g, count, minDistance = 6, rng = Math.random) {
    const rows = g.length,
      cols = g[0].length;
    const candidates = [];

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        if (g[row][col] !== 0) continue;
        const hasFloorNeighbor = [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ].some(([dr, dc]) => {
          const r = row + dr,
            c = col + dc;
          return r >= 0 && c >= 0 && r < rows && c < cols && g[r][c] === 1;
        });
        if (hasFloorNeighbor) candidates.push([row, col]);
      }
    }

    shuffle(candidates, rng);

    const chosen = [];
    for (const [row, col] of candidates) {
      if (chosen.length >= count) break;
      const tooClose = chosen.some(([r, c]) => Math.hypot(r - row, c - col) < minDistance);
      if (!tooClose) chosen.push([row, col]);
    }

    const markers = new Map();
    for (const [row, col] of chosen) {
      markers.set(`${row},${col}`, { claimed: false });
    }
    return markers;
  }
}
