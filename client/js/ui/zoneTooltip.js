import { Board } from "../../../shared/engine/board.js";

export class ZoneTooltip {
  constructor(canvas) {
    this.canvas = canvas;
    this.el = document.getElementById("zoneTooltip");

    // Real zones are write-once (Zone.cellSet/Zone.cost never change after
    // Zone.create()), so once we've found where its tooltip box sits in
    // cell-space, that answer is good for the rest of the match — cache it
    // instead of re-running the box search (and re-measuring the DOM
    // element) on every hover of a zone we've already solved.
    // Not used for zone previews (unclaimed cells).
    this._placementCache = new Map(); // zoneId -> { chosen, cost }

    // The cache is keyed purely on cell-space geometry (which board cells
    // the tooltip box would land on), but that answer depends on how many
    // board cells the tooltip's fixed CSS size covers right now — which
    // changes with pinch-zoom (CSS transform scale) or a window resize.
    // We already read cssCellW/cssCellH every call (needed for live pixel
    // positioning regardless of caching), so comparing against the last
    // seen values costs nothing extra and catches zoom and resize.
    this._geometryKey = null;
  }

  hide() {
    if (this.el) this.el.hidden = true;
  }

  update(cell, board, zones, zonePreview = null) {
    if (!this.el) return;

    if (zonePreview) {
      this._show(null, zonePreview.cellSet, zonePreview.cost, board);
      return;
    }

    const zoneId = cell ? board.zoneIdAt(cell[0], cell[1]) : null;
    if (zoneId === null) {
      this.hide();
      return;
    }

    const zone = zones[zoneId];
    this._show(zoneId, zone.cellSet, zone.cost, board);
  }

  // zoneId is null for zone previews.
  _show(zoneId, cellSet, cost, board) {
    if (cellSet.size === 0) {
      this.hide();
      return;
    }

    const { cssCellW, cssCellH, offsetX, offsetY } = this._boardRectInfo(board);
    this._syncGeometry(cssCellW, cssCellH);

    let cached = zoneId !== null ? this._placementCache.get(zoneId) : null;
    if (!cached) {
      const chosen = this._computePlacement(cellSet, board, cost, cssCellW, cssCellH);
      if (!chosen) {
        this.hide();
        return;
      }
      cached = { chosen, cost };
      if (zoneId !== null) this._placementCache.set(zoneId, cached);
    } else {
      this.el.textContent = `Reward: ${cached.cost}`;
    }

    this.el.style.left = `${offsetX + cached.chosen.centerCol * cssCellW}px`;
    this.el.style.top = `${offsetY + cached.chosen.centerRow * cssCellH}px`;
    this.el.hidden = false;
  }

  // Clears the placement cache whenever the board's on-screen cell size
  // changes (zoom or resize) — a cached box was chosen assuming the
  // tooltip's fixed CSS footprint covered a certain number of *board*
  // cells, and that count shifts with cell size even though nothing about
  // the zone itself changed.
  _syncGeometry(cssCellW, cssCellH) {
    const key = `${cssCellW},${cssCellH}`;
    if (key !== this._geometryKey) {
      this._geometryKey = key;
      this._placementCache.clear();
    }
  }

  // Everything that's only needed on a cache miss: centroid, DOM
  // measurement, and the box search.
  _computePlacement(cellSet, board, cost, cssCellW, cssCellH) {
    const cells = Array.from(cellSet, Board.parse);

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

    return this._findPlacement(cellSet, board, wCells, hCells, targetRow, targetCol);
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
    // A valid box must directly touch a zone cell (its row/col-adjacent
    // edge), so it can only ever land within hCells/wCells of the zone's
    // own bounding box — scanning the whole board past that is guaranteed
    // wasted work. Padding by hCells/wCells (rather than the exact tight
    // bound) keeps this provably a superset of every valid candidate, so
    // it can't skip a real placement, while still shrinking the search
    // from board-sized to zone-sized for the common case of a small zone
    // on a large board.
    const bounds = this._searchBounds(cellSet, board, wCells, hCells);
    const raw = [
      ...this._scanColumns(cellSet, board, wCells, hCells, 0, bounds),
      ...this._scanColumns(cellSet, board, wCells, hCells, 0.5, bounds),
    ];
    if (raw.length === 0) return null;

    const placements = raw.map((p) => ({
      ...p,
      hDist: Math.abs(p.centerCol - targetCol),
      vDist: Math.abs(p.centerRow - targetRow),
    }));

    // prefer the box sitting above the zone (its bottom edge touches the zone)
    const preferred = placements.filter((p) => p.hasBelow);
    const candidates = preferred.length > 0 ? preferred : placements.filter((p) => p.hasAbove);
    if (candidates.length === 0) return null;

    const score = (p) => 4 * p.hDist * p.hDist + p.vDist * p.vDist;

    let best = candidates[0];
    let bestScore = score(best);
    for (let i = 1; i < candidates.length; i++) {
      const p = candidates[i];
      const s = score(p);
      const better =
        s < bestScore ||
        (s === bestScore && (p.vDist < best.vDist || (p.vDist === best.vDist && p.hDist < best.hDist)));
      if (better) {
        best = p;
        bestScore = s;
      }
    }
    return best;
  }

  _searchBounds(cellSet, board, wCells, hCells) {
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
      minRow: Math.max(0, minRow - hCells),
      maxRow: Math.min(board.rows - hCells, maxRow + 1),
      minCol: Math.max(0, minCol - wCells - 1),
      maxCol: Math.min(board.cols - 1, maxCol + wCells + 1),
    };
  }

  // colOffset 0: box left edge sits on a column line (checks exactly
  // wCells columns). colOffset 0.5: box straddles a column line, so it
  // partially covers one extra column on each side - those must still be
  // free, but only the fully-covered "core" columns count for the
  // zone-adjacency check.
  _scanColumns(cellSet, board, wCells, hCells, colOffset, bounds) {
    const straddling = colOffset > 0;
    const overlapSpan = straddling ? wCells + 1 : wCells;
    const coreStart = straddling ? 1 : 0;
    const coreSpan = straddling ? wCells - 1 : wCells;
    if (coreSpan <= 0) return []; // box too narrow to straddle meaningfully

    const margin = board.cols - overlapSpan >= 2 ? 1 : 0;
    const minI = Math.max(margin, bounds.minCol);
    const maxI = Math.min(board.cols - overlapSpan - margin, bounds.maxCol);
    const minRow0 = Math.max(0, bounds.minRow);
    const maxRow0 = Math.min(board.rows - hCells, bounds.maxRow);

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
    for (let r0 = minRow0; r0 <= maxRow0; r0++) {
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
