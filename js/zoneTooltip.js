import { Board } from "./board.js";

export class ZoneTooltip {
  constructor(canvas) {
    this.canvas = canvas;
    this.el = document.getElementById("zoneTooltip");
  }

  hide() {
    if (this.el) this.el.hidden = true;
  }

  update(cell, board, zones, zonePreview = null) {
    if (!this.el) return;

    if (zonePreview) {
      this._show(zonePreview.cellSet, zonePreview.cost, board);
      return;
    }

    const zoneId = cell ? board.zoneIdAt(cell[0], cell[1]) : null;
    if (zoneId === null) {
      this.hide();
      return;
    }

    const zone = zones[zoneId];
    this._show(zone.cellSet, zone.cost, board);
  }

  _show(cellSet, cost, board) {
    const cells = Array.from(cellSet, Board.parse);
    if (cells.length === 0) {
      this.hide();
      return;
    }

    const { cssCellW, cssCellH, offsetX, offsetY } = this._boardRectInfo(board);

    // ----- zone centroid (what we're trying to sit next to) -----
    const sumRow = cells.reduce((s, [r]) => s + r, 0);
    const sumCol = cells.reduce((s, [, c]) => s + c, 0);
    const targetRow = sumRow / cells.length;
    const targetCol = sumCol / cells.length;

    // ----- real box size, converted to how many board cells it covers -----
    this.el.textContent = `Reward: ${cost}`;
    const { wCells, hCells } = this._measureBoxCells(cssCellW, cssCellH);

    const chosen = this._findPlacement(cellSet, board, wCells, hCells, targetRow, targetCol);

    let centerRow, centerCol;
    if (chosen) {
      centerRow = chosen.r0 + hCells / 2;
      centerCol = chosen.c0 + wCells / 2;
    } else {
      ({ centerRow, centerCol } = this._boundingBoxCenter(cellSet));
    }

    this.el.style.left = `${offsetX + centerCol * cssCellW}px`;
    this.el.style.top = `${offsetY + centerRow * cssCellH}px`;
    this.el.hidden = false;
  }

  // Measures the tooltip's real pixel footprint and converts it to a
  // width/height in board cells, so the search below always reasons in
  // the box's *actual* size instead of an assumed 3x1.
  _measureBoxCells(cssCellW, cssCellH) {
    this.el.style.visibility = "hidden";
    this.el.hidden = false;
    const rect = this.el.getBoundingClientRect();
    this.el.style.visibility = "";

    return {
      wCells: Math.max(1, Math.ceil(rect.width / cssCellW)),
      hCells: Math.max(1, Math.ceil(rect.height / cssCellH)),
    };
  }

  // Searches every (r0, c0) top-left corner for a wCells x hCells box that:
  //  1. doesn't overlap any zone cell
  //  2. touches the zone directly above or below it
  // then picks the candidate closest to the zone centroid (horizontal
  // distance weighted heavier so the box doesn't drift too far sideways).
  _findPlacement(cellSet, board, wCells, hCells, targetRow, targetCol) {
    const margin = board.cols - wCells >= 2 ? 1 : 0;
    const minCol = margin;
    const maxCol0 = board.cols - wCells - margin;
    const maxRow0 = board.rows - hCells;

    const isBoxFree = (r0, c0) => {
      for (let r = r0; r < r0 + hCells; r++) {
        for (let c = c0; c < c0 + wCells; c++) {
          if (cellSet.has(`${r},${c}`)) return false;
        }
      }
      return true;
    };

    const touchesZoneAt = (row, c0) => {
      if (row < 0 || row >= board.rows) return false;
      for (let c = c0; c < c0 + wCells; c++) {
        if (cellSet.has(`${row},${c}`)) return true;
      }
      return false;
    };

    const placements = [];
    for (let r0 = 0; r0 <= maxRow0; r0++) {
      for (let c0 = minCol; c0 <= maxCol0; c0++) {
        if (!isBoxFree(r0, c0)) continue;

        const hasAbove = touchesZoneAt(r0 - 1, c0);
        const hasBelow = touchesZoneAt(r0 + hCells, c0);
        if (!hasAbove && !hasBelow) continue;

        const centerRow = r0 + hCells / 2;
        const centerCol = c0 + wCells / 2;
        placements.push({
          r0,
          c0,
          hasAbove,
          hasBelow,
          hDist: Math.abs(centerCol - targetCol),
          vDist: Math.abs(centerRow - targetRow),
        });
      }
    }

    if (placements.length === 0) return null;

    // prefer the box sitting above the zone (its bottom edge touches the zone)
    const preferred = placements.filter((p) => p.hasBelow);
    const candidates = preferred.length > 0 ? preferred : placements.filter((p) => p.hasAbove);

    const score = (p) => 4 * p.hDist * p.hDist + p.vDist * p.vDist;
    candidates.sort((a, b) => {
      const diff = score(a) - score(b);
      if (diff !== 0) return diff;
      if (a.vDist !== b.vDist) return a.vDist - b.vDist;
      return a.hDist - b.hDist;
    });

    return candidates[0];
  }

  _boundingBoxCenter(cellSet) {
    let minRow = Infinity,
      maxRow = -Infinity,
      minCol = Infinity,
      maxCol = -Infinity;
    for (const key of cellSet) {
      const [r, c] = Board.parse(key);
      if (r < minRow) minRow = r;
      if (r > maxRow) maxRow = r;
      if (c < minCol) minCol = c;
      if (c > maxCol) maxCol = c;
    }
    return {
      centerRow: (minRow + maxRow + 1) / 2,
      centerCol: (minCol + maxCol + 1) / 2,
    };
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
