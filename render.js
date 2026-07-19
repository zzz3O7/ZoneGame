const canvas = document.getElementById("board");
const ctx = canvas.getContext("2d");

canvas.width = COLS * LAYOUT.cellSize;
canvas.height = ROWS * LAYOUT.cellSize;

function drawBoard(grid, bonusMarkers) {
  const rows = grid.length,
    cols = grid[0].length;
  ctx.lineWidth = 1;

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x = col * LAYOUT.cellSize;
      const y = row * LAYOUT.cellSize;
      const key = `${row},${col}`;
      const hasBonus = bonusMarkers.has(key) && !bonusMarkers.get(key).claimed;

      if (grid[row][col] === 1) {
        ctx.fillStyle = THEME.floor;
      } else if (hasBonus) {
        ctx.fillStyle = THEME.wallBonus;
      } else {
        ctx.fillStyle = THEME.wall;
      }
      ctx.fillRect(x, y, LAYOUT.cellSize, LAYOUT.cellSize);
      ctx.strokeStyle = THEME.gridLine;
      ctx.strokeRect(x, y, LAYOUT.cellSize, LAYOUT.cellSize);
    }
  }

  ctx.fillStyle = THEME.bonusText;
  ctx.font = `${LAYOUT.cellSize * LAYOUT.bonusFontRatio}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const [key, marker] of bonusMarkers) {
    if (marker.claimed) continue;
    const [row, col] = key.split(",").map(Number);
    ctx.fillText("+5", col * LAYOUT.cellSize + LAYOUT.cellSize / 2, row * LAYOUT.cellSize + LAYOUT.cellSize / 2);
  }
}

function drawZones(zones, currentPlayer) {
  for (const zone of zones) {
    let color;
    if (!zone.active) {
      color = THEME.inactiveZone;
    } else {
      color = zone.localTurn === currentPlayer ? THEME.availibleZone : THEME.unavailibleZone;
    }
    ctx.fillStyle = color;
    for (const key of zone.cellSet) {
      const [r, c] = key.split(",").map(Number);
      ctx.fillRect(c * LAYOUT.cellSize, r * LAYOUT.cellSize, LAYOUT.cellSize, LAYOUT.cellSize);
    }
  }
}

function drawZoneBorders(zones) {
  ctx.strokeStyle = THEME.zoneBorders;
  ctx.lineWidth = 3;
  for (const zone of zones) {
    for (const key of zone.cellSet) {
      const [r, c] = key.split(",").map(Number);
      const x = c * LAYOUT.cellSize,
        y = r * LAYOUT.cellSize;

      for (const [dr, dc, edge] of [
        [-1, 0, "top"],
        [1, 0, "bottom"],
        [0, -1, "left"],
        [0, 1, "right"],
      ]) {
        const nr = r + dr,
          nc = c + dc;
        if (zone.cellSet.has(`${nr},${nc}`)) continue;

        ctx.beginPath();
        if (edge === "top") {
          ctx.moveTo(x, y);
          ctx.lineTo(x + LAYOUT.cellSize, y);
        }
        if (edge === "bottom") {
          ctx.moveTo(x, y + LAYOUT.cellSize);
          ctx.lineTo(x + LAYOUT.cellSize, y + LAYOUT.cellSize);
        }
        if (edge === "left") {
          ctx.moveTo(x, y);
          ctx.lineTo(x, y + LAYOUT.cellSize);
        }
        if (edge === "right") {
          ctx.moveTo(x + LAYOUT.cellSize, y);
          ctx.lineTo(x + LAYOUT.cellSize, y + LAYOUT.cellSize);
        }
        ctx.stroke();
      }
    }
  }
}

function drawPieces(occupied) {
  ctx.fillStyle = THEME.piece;
  for (const key of occupied) {
    const [r, c] = key.split(",").map(Number);
    ctx.fillRect(c * LAYOUT.cellSize + 2, r * LAYOUT.cellSize + 2, LAYOUT.cellSize - 4, LAYOUT.cellSize - 4);
  }
}

function drawZonePreview(grid, cellZone, hoverCell, hoverShape, bonusMarkers) {
  if (!hoverCell || !hoverShape) return;
  const [r, c] = hoverCell;
  if (cellZone[r][c] !== null) return;
  if (grid[r][c] === 0) return;

  const cellSet = floodFillZone(grid, cellZone, r, c, ZONE_RADIUS);
  const bonuses = bonusesInZone(cellSet, bonusMarkers, r, c, ZONE_RADIUS);

  ctx.fillStyle = THEME.pendingNewZone;
  for (const key of cellSet) {
    const [pr, pc] = key.split(",").map(Number);
    ctx.fillRect(pc * LAYOUT.cellSize, pr * LAYOUT.cellSize, LAYOUT.cellSize, LAYOUT.cellSize);
  }

  ctx.fillStyle = THEME.pendingBonuses;
  for (const key of bonuses) {
    const [pr, pc] = key.split(",").map(Number);
    ctx.fillRect(pc * LAYOUT.cellSize, pr * LAYOUT.cellSize, LAYOUT.cellSize, LAYOUT.cellSize);
  }
}

function drawGesturePath(path) {
  ctx.fillStyle = THEME.gesturePath;
  for (const key of path) {
    const [r, c] = key.split(",").map(Number);
    ctx.fillRect(c * LAYOUT.cellSize, r * LAYOUT.cellSize, LAYOUT.cellSize, LAYOUT.cellSize);
  }
}

function drawGhost(grid, cellZone, occupied, zones, pieceType, dominoLeft, hoverCell, hoverShape, currentPlayer) {
  if (!hoverCell || !hoverShape) return;
  const rows = grid.length,
    cols = grid[0].length;
  const [hr, hc] = hoverCell;
  const valid = canPlaceHere(grid, cellZone, occupied, zones, pieceType, dominoLeft, currentPlayer, hoverShape, hr, hc);

  ctx.fillStyle = valid ? THEME.ghostShapeValid : THEME.ghostShapeInvalid;
  for (const [r, c] of getShapeCells(hoverShape, hr, hc)) {
    if (r >= 0 && c >= 0 && r < rows && c < cols) {
      ctx.fillRect(c * LAYOUT.cellSize, r * LAYOUT.cellSize, LAYOUT.cellSize, LAYOUT.cellSize);
    }
  }
}

function render(
  grid,
  cellZone,
  zones,
  occupied,
  bonusMarkers,
  hoverCell,
  hoverShape,
  pieceType,
  dominoLeft,
  currentPlayer,
  gesturePath,
) {
  drawBoard(grid, bonusMarkers);
  drawZones(zones, currentPlayer);
  drawZoneBorders(zones);
  drawZonePreview(grid, cellZone, hoverCell, hoverShape, bonusMarkers);
  drawPieces(occupied);
  drawGesturePath(gesturePath);
  drawGhost(grid, cellZone, occupied, zones, pieceType, dominoLeft, hoverCell, hoverShape, currentPlayer);
}
