import { LAYOUT, THEME, ZONE_RADIUS } from "./config.js";
import { Board } from "./board.js";
import { Shape } from "./shape.js";
import { Zone } from "./zone.js";
import { Rules } from "./rules.js";

export class Renderer {
  constructor(canvas, board) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");

    this.cellSize = Math.floor(LAYOUT.targetBoardSize / Math.max(board.cols, board.rows));
    canvas.width = board.cols * this.cellSize;
    canvas.height = board.rows * this.cellSize;
  }

  render(board, zones, currentPlayer, pieceType, hoverShape, hoverCell, gesturePath) {
    this._drawBoard(board);
    this._drawZones(zones, currentPlayer.id);
    this._drawZoneBorders(zones);
    this._drawZonePreview(board, hoverShape, hoverCell);
    this._drawPieces(board);
    this._drawGesturePath(gesturePath);
    this._drawGhost(board, zones, currentPlayer, pieceType, hoverShape, hoverCell);
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

  _drawZones(zones, currentPlayerIndex) {
    const { ctx } = this;
    for (const zone of zones) {
      const color = !zone.active
        ? THEME.inactiveZone
        : zone.localTurn === currentPlayerIndex
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
    ctx.lineWidth = 3;

    for (const zone of zones) {
      for (const key of zone.cellSet) {
        const [r, c] = Board.parse(key);
        const x = c * this.cellSize,
          y = r * this.cellSize;

        for (const [dr, dc, edge] of [
          [-1, 0, "top"],
          [1, 0, "bottom"],
          [0, -1, "left"],
          [0, 1, "right"],
        ]) {
          const nr = r + dr,
            nc = c + dc;
          if (zone.cellSet.has(Board.key(nr, nc))) continue;

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
  }

  _drawPieces(board) {
    const { ctx } = this;
    ctx.fillStyle = THEME.piece;
    for (const key of board.occupied) {
      const [r, c] = Board.parse(key);
      ctx.fillRect(c * this.cellSize + 2, r * this.cellSize + 2, this.cellSize - 4, this.cellSize - 4);
    }
  }

  _drawZonePreview(board, hoverShape, hoverCell) {
    if (!hoverCell || !hoverShape) return;
    const [r, c] = hoverCell;
    if (board.zoneIdAt(r, c) !== null) return;
    if (!board.isFloor(r, c)) return;

    const { ctx } = this;
    const cellSet = Zone.floodFill(board, r, c, ZONE_RADIUS);
    const bonuses = Zone.bonusesInRange(board, cellSet, r, c, ZONE_RADIUS);

    ctx.fillStyle = THEME.pendingNewZone;
    for (const key of cellSet) {
      const [pr, pc] = Board.parse(key);
      ctx.fillRect(pc * this.cellSize, pr * this.cellSize, this.cellSize, this.cellSize);
    }

    ctx.fillStyle = THEME.pendingBonuses;
    for (const key of bonuses) {
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

  _drawGhost(board, zones, currentPlayer, pieceType, hoverShape, hoverCell) {
    if (!hoverCell || !hoverShape) return;
    const [hr, hc] = hoverCell;
    const valid = Rules.canPlaceHere(board, zones, currentPlayer, pieceType, hoverShape, hr, hc);

    this.ctx.fillStyle = valid ? THEME.ghostShapeValid : THEME.ghostShapeInvalid;
    for (const [r, c] of Shape.cellsAt(hoverShape, hr, hc)) {
      if (board.isInside(r, c)) {
        this.ctx.fillRect(c * this.cellSize, r * this.cellSize, this.cellSize, this.cellSize);
      }
    }
  }
}
