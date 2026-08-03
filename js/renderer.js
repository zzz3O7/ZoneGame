import { LAYOUT, THEME } from "./config.js";
import { Board } from "./board.js";
import { Shape } from "./shape.js";
import { Zone } from "./zone.js";
import { Rules } from "./rules.js";
import { ORTHOGONAL_EDGES } from "./directions.js";

export class Renderer {
  constructor(canvas, board, zoneRadius) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.zoneRadius = zoneRadius;

    this.cellSize = Math.floor(LAYOUT.canvasResolution / Math.max(board.cols, board.rows));
    canvas.width = board.cols * this.cellSize;
    canvas.height = board.rows * this.cellSize;
  }

  render(
    board,
    zones,
    currentPlayerIndex,
    viewer,
    pieceType,
    anchorShape,
    anchorCell,
    cursorCell,
    gesturePath,
    highlightEntry,
    hoveredZoneIds,
    entries,
  ) {
    this._drawBoard(board);
    this._drawZones(zones, viewer.id);
    this._drawZoneBorders(zones);
    const zoneIds = hoveredZoneIds ?? this._cursorZoneIdSet(board, cursorCell);
    this._drawZoneHighlight(zones, zoneIds);
    this._drawZonePreview(board, anchorShape, anchorCell);
    this._drawPieces(entries);
    this._drawMoveHighlight(highlightEntry);
    this._drawGesturePath(gesturePath);
    this._drawGhost(board, zones, currentPlayerIndex, viewer, pieceType, anchorShape, anchorCell);
  }

  _drawBoard(board) {
    const { ctx } = this;
    ctx.lineWidth = 1;

    for (let row = 0; row < board.rows; row++) {
      for (let col = 0; col < board.cols; col++) {
        const x = col * this.cellSize;
        const y = row * this.cellSize;
        const marker = board.bonusMarkers.get(Board.key(row, col));
        const hasBonus = marker && !marker.claimed;

        if (board.grid[row][col] === 1) ctx.fillStyle = THEME.floor;
        else if (hasBonus) ctx.fillStyle = THEME.wallBonus;
        else ctx.fillStyle = THEME.wall;

        ctx.fillRect(x, y, this.cellSize, this.cellSize);
        ctx.strokeStyle = THEME.gridLine;
        ctx.strokeRect(x, y, this.cellSize, this.cellSize);
      }
    }

    ctx.fillStyle = THEME.bonusText;
    ctx.font = `${this.cellSize * LAYOUT.bonusFontRatio}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const [key, marker] of board.bonusMarkers) {
      if (marker.claimed) continue;
      const [row, col] = Board.parse(key);
      ctx.fillText("+5", col * this.cellSize + this.cellSize / 2, row * this.cellSize + this.cellSize / 2);
    }
  }

  _drawZones(zones, viewerIndex) {
    const { ctx } = this;
    for (const zone of zones) {
      const color = !zone.active
        ? THEME.inactiveZone
        : zone.localTurn === viewerIndex
          ? THEME.availibleZone
          : THEME.unavailibleZone;

      ctx.fillStyle = color;
      for (const key of zone.cellSet) {
        const [r, c] = Board.parse(key);
        ctx.fillRect(c * this.cellSize, r * this.cellSize, this.cellSize, this.cellSize);
      }
    }
  }

  _drawZoneBorders(zones) {
    const ctx = this.ctx;
    ctx.strokeStyle = THEME.zoneBorders;
    ctx.lineWidth = 2;
    for (const zone of zones) this._strokeZoneBorder(zone);
  }

  _cursorZoneIdSet(board, cursorCell) {
    if (!cursorCell) return null;
    const id = board.zoneIdAt(cursorCell[0], cursorCell[1]);
    return id == null ? null : new Set([id]);
  }

  _drawZoneHighlight(zones, highlightedZoneIds) {
    if (!highlightedZoneIds || highlightedZoneIds.size === 0) return;
    const ctx = this.ctx;
    ctx.strokeStyle = THEME.zoneBordersHighlight;
    ctx.lineWidth = 3;
    for (const zone of zones) {
      if (highlightedZoneIds.has(zone.id)) this._strokeZoneBorder(zone);
    }
  }

  _strokeZoneBorder(zone) {
    this._strokeCellSetBorder(zone.cellSet);
  }

  _drawMoveHighlight(entry) {
    if (!entry || entry.type === "pass") return;
    const cells = Shape.cellsAt(entry.shape, entry.anchorRow, entry.anchorCol);
    const cellSet = new Set(cells.map(([r, c]) => Board.key(r, c)));
    this.ctx.strokeStyle = THEME.moveHighlight;
    this.ctx.lineWidth = 3;
    this._strokeCellSetBorder(cellSet);
  }

  // shared edge-detection stroke: draw a border edge only where the
  // orthogonal neighbor isn't in the same set.
  _strokeCellSetBorder(cellSet) {
    const ctx = this.ctx;
    for (const key of cellSet) {
      const [r, c] = Board.parse(key);
      const x = c * this.cellSize,
        y = r * this.cellSize;

      for (const [dr, dc, edge] of ORTHOGONAL_EDGES) {
        const nr = r + dr,
          nc = c + dc;
        if (cellSet.has(Board.key(nr, nc))) continue;

        ctx.beginPath();
        if (edge === "top") {
          ctx.moveTo(x, y);
          ctx.lineTo(x + this.cellSize, y);
        }
        if (edge === "bottom") {
          ctx.moveTo(x, y + this.cellSize);
          ctx.lineTo(x + this.cellSize, y + this.cellSize);
        }
        if (edge === "left") {
          ctx.moveTo(x, y);
          ctx.lineTo(x, y + this.cellSize);
        }
        if (edge === "right") {
          ctx.moveTo(x + this.cellSize, y);
          ctx.lineTo(x + this.cellSize, y + this.cellSize);
        }
        ctx.stroke();
      }
    }
  }

  _drawPieces(entries) {
    const ctx = this.ctx;
    ctx.fillStyle = THEME.piece;
    const inset = 3;

    for (const entry of entries) {
      if (entry.type === "pass") continue;
      const cells = Shape.cellsAt(entry.shape, entry.anchorRow, entry.anchorCol);
      const cellSet = new Set(cells.map(([r, c]) => Board.key(r, c)));

      for (const [r, c] of cells) {
        const x = c * this.cellSize,
          y = r * this.cellSize;
        ctx.fillRect(x + inset, y + inset, this.cellSize - inset * 2, this.cellSize - inset * 2);
      }

      // bridge the gap between two cells of the *same* piece so it reads
      // as one united shape instead of separate squares -- only check
      // right/bottom per cell, each adjacency only needs filling once
      for (const [r, c] of cells) {
        const x = c * this.cellSize,
          y = r * this.cellSize;
        if (cellSet.has(Board.key(r, c + 1))) {
          ctx.fillRect(x + this.cellSize - inset, y + inset, inset * 2, this.cellSize - inset * 2);
        }
        if (cellSet.has(Board.key(r + 1, c))) {
          ctx.fillRect(x + inset, y + this.cellSize - inset, this.cellSize - inset * 2, inset * 2);
        }
      }
    }
  }

  _drawZonePreview(board, anchorShape, anchorCell) {
    if (!anchorCell || !anchorShape) return;
    const [r, c] = anchorCell;
    const preview = Zone.preview(board, r, c, this.zoneRadius);
    if (!preview) return;

    const { ctx } = this;
    ctx.fillStyle = THEME.pendingNewZone;
    for (const key of preview.cellSet) {
      const [pr, pc] = Board.parse(key);
      ctx.fillRect(pc * this.cellSize, pr * this.cellSize, this.cellSize, this.cellSize);
    }

    ctx.fillStyle = THEME.pendingBonuses;
    for (const key of preview.bonusKeys) {
      const [pr, pc] = Board.parse(key);
      ctx.fillRect(pc * this.cellSize, pr * this.cellSize, this.cellSize, this.cellSize);
    }
  }

  _drawGesturePath(path) {
    const { ctx } = this;
    ctx.fillStyle = THEME.gesturePath;
    for (const cell of path) {
      const [r, c] = cell;
      ctx.fillRect(c * this.cellSize, r * this.cellSize, this.cellSize, this.cellSize);
    }
  }

  _drawGhost(board, zones, currentPlayerIndex, viewer, pieceType, anchorShape, anchorCell) {
    if (!anchorCell || !anchorShape) return;
    const [hr, hc] = anchorCell;
    const valid =
      currentPlayerIndex == viewer.id && Rules.canPlaceHere(board, zones, viewer, pieceType, anchorShape, hr, hc);

    this.ctx.fillStyle = valid ? THEME.ghostShapeValid : THEME.ghostShapeInvalid;
    for (const [r, c] of Shape.cellsAt(anchorShape, hr, hc)) {
      if (board.isInside(r, c)) {
        this.ctx.fillRect(c * this.cellSize, r * this.cellSize, this.cellSize, this.cellSize);
      }
    }
  }
}
