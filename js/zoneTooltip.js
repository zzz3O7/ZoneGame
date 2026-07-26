import { Board } from "./board.js";

// Owns the floating "zone reward" tooltip shown while hovering the board.
// Pure geometry + DOM — knows nothing about input mode, gestures, or turns.
export class ZoneTooltip {
  constructor(canvas) {
    this.canvas = canvas;
    this.el = document.getElementById("zoneTooltip");
  }

  hide() {
    if (this.el) this.el.hidden = true;
  }

  update(cell, board, zones) {
    if (!this.el) return;

    const zoneId = cell ? board.zoneIdAt(cell[0], cell[1]) : null;
    if (zoneId === null) {
      this.hide();
      return;
    }

    const zone = zones[zoneId];
    let minRow = Infinity,
      maxRow = -Infinity,
      minCol = Infinity,
      maxCol = -Infinity;
    for (const key of zone.cellSet) {
      const [r, c] = Board.parse(key);
      if (r < minRow) minRow = r;
      if (r > maxRow) maxRow = r;
      if (c < minCol) minCol = c;
      if (c > maxCol) maxCol = c;
    }

    const { cssCellW, cssCellH, offsetX, offsetY } = this._boardRectInfo(board);
    const centerX = offsetX + ((minCol + maxCol + 1) / 2) * cssCellW;
    const topY = offsetY + minRow * cssCellH;
    const bottomY = offsetY + (maxRow + 1) * cssCellH;
    const showAbove = topY > 30;

    this.el.textContent = `Reward: ${zone.cost}`;
    this.el.style.left = `${centerX}px`;
    this.el.style.top = showAbove ? `${topY}px` : `${bottomY}px`;
    this.el.classList.toggle("zone-tooltip--above", showAbove);
    this.el.classList.toggle("zone-tooltip--below", !showAbove);
    this.el.hidden = false;
  }

  _boardRectInfo(board) {
    const rect = this.canvas.getBoundingClientRect();
    const wrapRect = this.canvas.parentElement.getBoundingClientRect();
    return {
      cssCellW: rect.width / board.cols,
      cssCellH: rect.height / board.rows,
      offsetX: rect.left - wrapRect.left,
      offsetY: rect.top - wrapRect.top,
    };
  }
}
