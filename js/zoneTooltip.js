import { Board } from "./board.js";

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
    const cells = Array.from(zone.cellSet, Board.parse);
    if (cells.length === 0) {
      this.hide();
      return;
    }

    // ----- target point -----
    const sumRow = cells.reduce((s, [r]) => s + r, 0);
    const sumCol = cells.reduce((s, [, c]) => s + c, 0);
    const targetRow = sumRow / cells.length;
    const targetCol = sumCol / cells.length;

    // ----- board limits -----
    const maxCol = board.cols - 2;
    const minCol = 1;
    const isFree = (r, c) => !zone.cellSet.has(`${r},${c}`);

    // ----- collect all valid placements -----
    const placements = []; // { r, c, hasBelow, hasAbove, hDist, vDist }

    for (let r = 0; r < board.rows; r++) {
      for (let c = minCol; c <= maxCol; c++) {
        // 1. No overlap in tooltip row
        if (!isFree(r, c - 1) || !isFree(r, c) || !isFree(r, c + 1)) continue;

        // 2. Must be adjacent (touching zone from above or below)
        let hasBelow = false;
        let hasAbove = false;
        for (let dc = -1; dc <= 1; dc++) {
          const col = c + dc;
          if (r + 1 < board.rows && zone.cellSet.has(`${r + 1},${col}`)) hasBelow = true;
          if (r - 1 >= 0 && zone.cellSet.has(`${r - 1},${col}`)) hasAbove = true;
        }
        if (!hasBelow && !hasAbove) continue;

        const hDist = Math.abs(c - targetCol);
        const vDist = Math.abs(r - targetRow);
        placements.push({ r, c, hasBelow, hasAbove, hDist, vDist });
      }
    }

    // sub cell placements
    for (let r = 0; r < board.rows; r++) {
      for (let c = minCol; c <= maxCol - 1; c++) {
        // 1. No overlap in tooltip row
        if (!isFree(r, c - 1) || !isFree(r, c) || !isFree(r, c + 1) || !isFree(r, c + 2)) continue;

        // 2. Must be adjacent (touching zone from above or below)
        let hasBelow = false;
        let hasAbove = false;
        for (let dc = 0; dc <= 1; dc++) {
          const col = c + dc;
          if (r + 1 < board.rows && zone.cellSet.has(`${r + 1},${col}`)) hasBelow = true;
          if (r - 1 >= 0 && zone.cellSet.has(`${r - 1},${col}`)) hasAbove = true;
        }
        if (!hasBelow && !hasAbove) continue;

        const subC = c + 0.5;
        const hDist = Math.abs(subC - targetCol);
        const vDist = Math.abs(r - targetRow);
        placements.push({ r, c: subC, hasBelow, hasAbove, hDist, vDist });
      }
    }

    if (placements.length === 0) {
      this._fallbackBoundingBox(zone, board);
      return;
    }

    // ----- prefer above if possible -----
    const abovePlacements = placements.filter((p) => p.hasBelow);
    const candidates = abovePlacements.length > 0 ? abovePlacements : placements.filter((p) => p.hasAbove);

    const score = (a) => 4 * a.hDist * a.hDist + a.vDist * a.vDist;

    // ----- sort by score -----
    candidates.sort((a, b) => {
      const scoreA = score(a);
      const scoreB = score(b);
      if (scoreA !== scoreB) return scoreA - scoreB;
      if (a.vDist !== b.vDist) return a.vDist - b.vDist;
      if (a.hDist !== b.hDist) return a.hDist - b.hDist;
      return 0;
    });

    const chosen = candidates[0];

    // ----- pixel coordinates (tooltip centre) -----
    const { cssCellW, cssCellH, offsetX, offsetY } = this._boardRectInfo(board);
    const centerX = offsetX + (chosen.c + 0.5) * cssCellW;
    const centerY = offsetY + (chosen.r + 0.5) * cssCellH;

    this.el.textContent = `Reward: ${zone.cost}`;
    this.el.style.left = `${centerX}px`;
    this.el.style.top = `${centerY}px`;
    this.el.hidden = false;
  }

  _fallbackBoundingBox(zone, board) {
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
    const centerY = offsetY + ((minRow + maxRow + 1) / 2) * cssCellH;

    this.el.textContent = `Reward: ${zone.cost}`;
    this.el.style.left = `${centerX}px`;
    this.el.style.top = `${centerY}px`;
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
