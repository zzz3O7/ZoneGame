function floodFillZone(grid, cellZone, startRow, startCol, radius) {
  const rows = grid.length,
    cols = grid[0].length;
  const cellSet = new Set();
  const visited = new Set();
  const queue = [[startRow, startCol]];
  visited.add(`${startRow},${startCol}`);
  if (grid[startRow][startCol] === 0) return cellSet;

  while (queue.length) {
    const [r, c] = queue.shift();
    const dist = Math.max(Math.abs(r - startRow), Math.abs(c - startCol));
    if (dist > radius) continue;
    if (cellZone[r][c] !== null) continue;

    cellSet.add(`${r},${c}`);

    for (const [dr, dc] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const nr = r + dr,
        nc = c + dc;
      const key = `${nr},${nc}`;
      if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue;
      if (grid[nr][nc] !== 1) continue;
      if (visited.has(key)) continue;
      visited.add(key);
      queue.push([nr, nc]);
    }
  }
  return cellSet;
}

function bonusesInZone(cellSet, bonusMarkers, anchorRow, anchorCol, radius) {
  const found = new Set();
  for (const key of bonusMarkers.keys()) {
    if (bonusMarkers.get(key).claimed) continue;
    const [r, c] = key.split(",").map(Number);
    const dist = Math.max(Math.abs(r - anchorRow), Math.abs(c - anchorCol));
    if (dist > radius) continue;

    const adjacentToZone = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ].some(([dr, dc]) => cellSet.has(`${r + dr},${c + dc}`));
    if (adjacentToZone) found.add(key);
  }
  return found;
}

function createZone(grid, cellZone, zones, bonusMarkers, anchorRow, anchorCol, creator, radius) {
  const id = zones.length;
  const cellSet = floodFillZone(grid, cellZone, anchorRow, anchorCol, radius);
  const bonusKeys = bonusesInZone(cellSet, bonusMarkers, anchorRow, anchorCol, radius);

  for (const key of bonusKeys) {
    bonusMarkers.get(key).claimed = true;
  }

  const cost = cellSet.size + bonusKeys.size * 5;
  for (const key of cellSet) {
    const [r, c] = key.split(",").map(Number);
    cellZone[r][c] = id;
  }

  const zone = { id, cellSet, cost, active: true, creator, localTurn: 1 - creator };
  zones.push(zone);
  return zone;
}

function canPlaceHere(grid, cellZone, occupied, zones, pieceType, dominoLeft, player, shape, anchorRow, anchorCol) {
  if (pieceType === "domino" && dominoLeft[player] <= 0) return false;
  if (!isValidPlacement(grid, occupied, shape, anchorRow, anchorCol)) return false;

  const cells = getShapeCells(shape, anchorRow, anchorCol);
  const zoneIds = new Set(cells.map(([r, c]) => cellZone[r][c]));

  if (zoneIds.size > 1) return false;

  const zoneId = [...zoneIds][0];
  if (zoneId === null) return true;

  const zone = zones[zoneId];
  return zone.active && zone.localTurn === player;
}

function zoneHasMove(grid, cellZone, occupied, zones, zone, dominoLeft, player, availableTypes) {
  for (const type of availableTypes) {
    for (const shape of SHAPE_VARIANTS[type]) {
      for (const key of zone.cellSet) {
        if (occupied.has(key)) continue;
        const [r, c] = key.split(",").map(Number);
        if (canPlaceHere(grid, cellZone, occupied, zones, type, dominoLeft, player, shape, r, c)) return true;
      }
    }
  }
  return false;
}

function canPlayerMove(grid, cellZone, occupied, zones, dominoLeft, player, availableTypes) {
  const rows = grid.length,
    cols = grid[0].length;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (grid[r][c] !== 1) continue;
      for (const type of availableTypes) {
        for (const shape of SHAPE_VARIANTS[type]) {
          if (canPlaceHere(grid, cellZone, occupied, zones, type, dominoLeft, player, shape, r, c)) return true;
        }
      }
    }
  }
  return false;
}
