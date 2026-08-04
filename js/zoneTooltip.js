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
    // +0.5: a cell's index is its left/top edge in this coordinate space
    // (matches the renderer, which draws cell c at [c, c+1)), so its true
    // visual center is index + 0.5.
    const targetRow = sumRow / cells.length + 0.5;
    const targetCol = sumCol / cells.length + 0.5;

    // ----- real box size, converted to how many board cells it covers -----
    this.el.textContent = `Reward: ${cost}`;
    const { wCells, hCells } = this._measureBoxCells(cssCellW, cssCellH);

    const chosen = this._findPlacement(cellSet, board, wCells, hCells, targetRow, targetCol);
    if (!chosen) {
      this.hide();
      return;
    }

    this.el.style.left = `${offsetX + chosen.centerCol * cssCellW}px`;
    this.el.style.top = `${offsetY + chosen.centerRow * cssCellH}px`;
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

  // Searches for a wCells x hCells box that doesn't overlap any zone cell
  // and touches the zone directly above or below it, then picks the
  // candidate closest to the zone centroid (horizontal distance weighted
  // heavier so the box doesn't drift too far sideways).
  //
  // Runs the horizontal scan at two alignments - grid-aligned (0) and
  // shifted half a cell (0.5) - because a box's achievable center columns
  // land on one or the other depending on wCells' parity. Even-width zones
  // center on a half-cell, so without the shifted pass there'd be no
  // candidate that actually sits centered on them.
  _findPlacement(cellSet, board, wCells, hCells, targetRow, targetCol) {
    const raw = [
      ...this._scanColumns(cellSet, board, wCells, hCells, 0),
      ...this._scanColumns(cellSet, board, wCells, hCells, 0.5),
    ];

    const placements = raw.map((p) => ({
      ...p,
      hDist: Math.abs(p.centerCol - targetCol),
      vDist: Math.abs(p.centerRow - targetRow),
    }));
    if (placements.length === 0) return null;

    // prefer the box sitting above the zone (its bottom edge touches the zone)
    const preferred = placements.filter((p) => p.hasBelow);
    const candidates = preferred.length > 0 ? preferred : placements.filter((p) => p.hasAbove);
    if (candidates.length === 0) return null;

    const score = (p) => 4 * p.hDist * p.hDist + p.vDist * p.vDist;
    candidates.sort((a, b) => {
      const diff = score(a) - score(b);
      if (diff !== 0) return diff;
      if (a.vDist !== b.vDist) return a.vDist - b.vDist;
      return a.hDist - b.hDist;
    });

    return candidates[0];
  }

  // colOffset 0: box left edge sits on a column line (checks exactly
  // wCells columns). colOffset 0.5: box straddles a column line, so it
  // partially covers one extra column on each side - those must still be
  // free, but only the fully-covered "core" columns count for the
  // zone-adjacency check.
  _scanColumns(cellSet, board, wCells, hCells, colOffset) {
    const straddling = colOffset > 0;
    const overlapSpan = straddling ? wCells + 1 : wCells;
    const coreStart = straddling ? 1 : 0;
    const coreSpan = straddling ? wCells - 1 : wCells;
    if (coreSpan <= 0) return []; // box too narrow to straddle meaningfully

    const margin = board.cols - overlapSpan >= 2 ? 1 : 0;
    const minI = margin;
    const maxI = board.cols - overlapSpan - margin;
    const maxRow0 = board.rows - hCells;

    const isBoxFree = (r0, i) => {
      for (let r = r0; r < r0 + hCells; r++) {
        for (let c = i; c < i + overlapSpan; c++) {
          if (cellSet.has(`${r},${c}`)) return false;
        }
      }
      return true;
    };

    const touchesZoneAt = (row, i) => {
      if (row < 0 || row >= board.rows) return false;
      for (let c = i + coreStart; c < i + coreStart + coreSpan; c++) {
        if (cellSet.has(`${row},${c}`)) return true;
      }
      return false;
    };

    const results = [];
    for (let r0 = 0; r0 <= maxRow0; r0++) {
      for (let i = minI; i <= maxI; i++) {
        if (!isBoxFree(r0, i)) continue;

        const hasAbove = touchesZoneAt(r0 - 1, i);
        const hasBelow = touchesZoneAt(r0 + hCells, i);
        if (!hasAbove && !hasBelow) continue;

        results.push({
          r0,
          centerRow: r0 + hCells / 2,
          centerCol: i + colOffset + wCells / 2,
          hasAbove,
          hasBelow,
        });
      }
    }
    return results;
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
