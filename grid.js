function randomFill(rows, cols, fillProb) {
  const g = [];
  for (let row = 0; row < rows; row++) {
    const gridRow = [];
    for (let col = 0; col < cols; col++) {
      gridRow.push(Math.random() < fillProb ? 0 : 1);
    }
    g.push(gridRow);
  }
  return g;
}

function countWallNeighbors(g, row, col) {
  let count = 0;
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const r = row + dr, c = col + dc;
      if (r < 0 || c < 0 || r >= g.length || c >= g[0].length || g[r][c] === 0) count++;
    }
  }
  return count;
}

function smooth(g) {
  const rows = g.length, cols = g[0].length;
  const ng = g.map(row => row.slice());
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      ng[row][col] = countWallNeighbors(g, row, col) >= 5 ? 0 : 1;
    }
  }
  return ng;
}

function removeIsolatedBorderWalls(g) {
  const rows = g.length, cols = g[0].length;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const isBorder = row === 0 || col === 0 || row === rows - 1 || col === cols - 1;
      if (isBorder && g[row][col] === 0 && countWallNeighbors(g, row, col) === 3) {
        g[row][col] = 1;
      }
    }
  }
  return g;
}

function findRegions(g) {
  const rows = g.length, cols = g[0].length;
  const visited = g.map(row => row.map(() => false));
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
          for (const [dr, dc] of [[1,0],[-1,0],[0,1],[0,-1]]) {
            const nr = r + dr, nc = c + dc;
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

function removeSmallRegions(g, minSize) {
  const regions = findRegions(g);
  for (const region of regions) {
    if (region.length <= minSize) {
      for (const [r, c] of region) g[r][c] = 0;
    }
  }
  return g;
}

function floorRatio(g) {
  let floor = 0, total = 0;
  for (const row of g) {
    for (const cell of row) {
      total++;
      if (cell === 1) floor++;
    }
  }
  return floor / total;
}

function generateGrid(rows, cols, fillProb = 0.6, smoothIter = 3, minRatio = 0.4, maxRatio = 0.6, maxAttempts = 30) {
    let g;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
    g = randomFill(rows, cols, fillProb);
    for (let i = 0; i < smoothIter; i++) g = smooth(g);
    g = removeIsolatedBorderWalls(g);
    g = removeSmallRegions(g, 10);
    

    const ratio = floorRatio(g);
    if (ratio >= minRatio && ratio <= maxRatio) {
      console.log(`Generated a board in ${attempt + 1} attempts`);
      return g;
    }
  }
  console.warn(`Unable to generate a good board in ${maxAttempts} attempts`);
  return g;
}

function placeBonusMarkers(g, count, minDistance = 6) {
  const rows = g.length, cols = g[0].length;
  const candidates = [];

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      if (g[row][col] !== 0) continue;
      const hasFloorNeighbor = [[1,0],[-1,0],[0,1],[0,-1]].some(([dr,dc]) => {
        const r = row + dr, c = col + dc;
        return r >= 0 && c >= 0 && r < rows && c < cols && g[r][c] === 1;
      });
      if (hasFloorNeighbor) candidates.push([row, col]);
    }
  }

  candidates.sort(() => Math.random() - 0.5);

  const chosen = [];
  for (const [row, col] of candidates) {
    if (chosen.length >= count) break;
    const tooClose = chosen.some(([r, c]) => {
      const dist = Math.hypot(r - row, c - col);
      return dist < minDistance;
    });
    if (!tooClose) chosen.push([row, col]);
  }

  const markers = new Map();
  for (const [row, col] of chosen) {
    markers.set(`${row},${col}`, { claimed: false });
  }
  return markers;
}