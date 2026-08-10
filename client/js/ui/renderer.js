import { LAYOUT, THEME } from "../../../shared/config.js";
import { Board } from "../../../shared/engine/board.js";
import { Shape } from "../../../shared/engine/shape.js";
import { Rules } from "../../../shared/engine/rules.js";
import { ORTHOGONAL_EDGES } from "../../../shared/engine/directions.js";

// Two stacked, same-size canvases instead of one:
//  - staticCanvas: board grid, zone fills/borders, placed pieces. Only
//    changes on a genuine game-state event (placement, pass, remote move),
//    so it's only redrawn from renderStatic() — called once per real
//    _render(), never from hover/rotate/flip/selection.
//  - canvas: ghost/zone-preview/gesture-path/highlights. Depends on
//    cursor/selection state, redrawn every renderDynamic() call (i.e.
//    every hover too).
// Splitting them means a hover no longer re-rasterizes the whole board —
// the browser compositor reuses the static layer's pixels for free, and
// renderDynamic() only has to clear+redraw the comparatively sparse
// cursor-dependent bits. Both canvases stay perfectly aligned because
// they're sized identically and share one CSS transform (applyTransform).
export class Renderer {
  constructor(canvas, staticCanvas, board, zoneRadius) {
    this.canvas = canvas; // dynamic/interactive layer (also the pointer-event target)
    this.staticCanvas = staticCanvas;
    this.ctx = canvas.getContext("2d");
    this.staticCtx = staticCanvas.getContext("2d");
    this.zoneRadius = zoneRadius;

    // Rasterized once per render call (a discrete game event — hover,
    // rotate, placement), never per animation frame: pinch-zoom is a pure
    // CSS transform on the canvas elements (see gameUI.js _applyPinch), so
    // it never triggers a redraw. That means we can afford a much higher
    // base resolution than the on-screen board size would suggest, so the
    // raster stays crisp instead of blurring when the CSS transform scales
    // it up — capped so we don't exceed mobile GPU canvas-size limits.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const targetResolution = LAYOUT.canvasResolution * dpr * LAYOUT.maxZoom;
    const resolution = Math.min(targetResolution, LAYOUT.maxCanvasDimension);

    this.cellSize = Math.floor(resolution / Math.max(board.cols, board.rows));
    canvas.width = staticCanvas.width = board.cols * this.cellSize;
    canvas.height = staticCanvas.height = board.rows * this.cellSize;

    // Precomputed once per Renderer instance (cellSize is fixed for its lifetime)
    this.gridLineWidth = this.cellSize * LAYOUT.gridLineRatio;
    this.zoneBorderWidth = this.cellSize * LAYOUT.zoneBorderRatio;
    this.zoneBorderHighlightWidth = this.cellSize * LAYOUT.zoneBorderHighlightRatio;
    this.moveHighlightWidth = this.cellSize * LAYOUT.moveHighlightRatio;
    this.pieceInset = this.cellSize * LAYOUT.pieceInsetRatio;
  }

  // Applies pinch-zoom/pan to both layers in one call, so they always move
  // together — GameUI never has to know there are two canvases.
  applyTransform(transform) {
    this.canvas.style.transform = transform;
    this.staticCanvas.style.transform = transform;
  }

  // "Waiting for opponent" dimming — applied to both layers so the effect
  // reads as one dimmed board rather than just dimming the (mostly
  // transparent) dynamic layer on top of a still-bright static one.
  setWaiting(waiting) {
    this.canvas.classList.toggle("board--waiting", waiting);
    this.staticCanvas.classList.toggle("board--waiting", waiting);
  }

  renderStatic(board, zones, viewerIndex, entries) {
    const ctx = this.staticCtx;
    ctx.clearRect(0, 0, this.staticCanvas.width, this.staticCanvas.height);
    this._drawBoard(ctx, board);
    this._drawZones(ctx, zones, viewerIndex);
    this._drawZoneBorders(ctx, zones);
    this._drawPieces(ctx, entries);
  }

  renderDynamic(
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
    zonePreview,
    calcCells,
  ) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const zoneIds = hoveredZoneIds ?? this._cursorZoneIdSet(board, cursorCell);
    this._drawZoneHighlight(ctx, zones, zoneIds);
    this._drawZonePreview(ctx, zonePreview);
    this._drawMoveHighlight(ctx, highlightEntry);
    this._drawGesturePath(ctx, gesturePath);
    this._drawGhost(ctx, board, zones, currentPlayerIndex, viewer, pieceType, anchorShape, anchorCell);
    this._drawCalcMarks(ctx, calcCells);
  }

  _drawBoard(ctx, board) {
    ctx.lineWidth = this.gridLineWidth;

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

  _drawZones(ctx, zones, viewerIndex) {
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

  _drawZoneBorders(ctx, zones) {
    ctx.strokeStyle = THEME.zoneBorders;
    ctx.lineWidth = this.zoneBorderWidth;
    for (const zone of zones) this._strokeZoneBorder(ctx, zone);
  }

  _cursorZoneIdSet(board, cursorCell) {
    if (!cursorCell) return null;
    const id = board.zoneIdAt(cursorCell[0], cursorCell[1]);
    return id == null ? null : new Set([id]);
  }

  _drawZoneHighlight(ctx, zones, highlightedZoneIds) {
    if (!highlightedZoneIds || highlightedZoneIds.size === 0) return;
    ctx.strokeStyle = THEME.zoneBordersHighlight;
    ctx.lineWidth = this.zoneBorderHighlightWidth;
    for (const zone of zones) {
      if (highlightedZoneIds.has(zone.id)) this._strokeZoneBorder(ctx, zone);
    }
  }

  _strokeZoneBorder(ctx, zone) {
    this._strokeCellSetBorder(ctx, zone.cellSet);
  }

  _drawMoveHighlight(ctx, entry) {
    if (!entry || entry.type === "pass") return;
    const cells = Shape.cellsAt(entry.shape, entry.anchorRow, entry.anchorCol);
    const cellSet = new Set(cells.map(([r, c]) => Board.key(r, c)));
    ctx.strokeStyle = THEME.moveHighlight;
    ctx.lineWidth = this.moveHighlightWidth;
    this._strokeCellSetBorder(ctx, cellSet);
  }

  // shared edge-detection stroke: draw a border edge only where the
  // orthogonal neighbor isn't in the same set.
  _strokeCellSetBorder(ctx, cellSet) {
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

  _drawPieces(ctx, entries) {
    ctx.fillStyle = THEME.piece;
    const inset = this.pieceInset;

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

  // preview is the already-computed Zone.preview() result (or null) —
  // GameUI computes it once in _syncCanvas() for the tooltip's "is the
  // cursor inside it" check, so the renderer just draws it instead of
  // recomputing the same flood-fill a second time.
  _drawZonePreview(ctx, preview) {
    if (!preview) return;

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

  _drawGesturePath(ctx, path) {
    ctx.fillStyle = THEME.gesturePath;
    for (const cell of path) {
      const [r, c] = cell;
      ctx.fillRect(c * this.cellSize, r * this.cellSize, this.cellSize, this.cellSize);
    }
  }

  _drawCalcMarks(ctx, cells) {
    if (!cells || cells.size === 0) return;
    for (const [key, color] of cells) {
      const [r, c] = Board.parse(key);
      ctx.fillStyle = color === "opponent" ? THEME.calcMarkOpponent : THEME.calcMarkSelf;
      ctx.fillRect(c * this.cellSize, r * this.cellSize, this.cellSize, this.cellSize);
    }
  }

  _drawGhost(ctx, board, zones, currentPlayerIndex, viewer, pieceType, anchorShape, anchorCell) {
    if (!anchorCell || !anchorShape) return;
    const [hr, hc] = anchorCell;
    const valid =
      currentPlayerIndex == viewer.id && Rules.canPlaceHere(board, zones, viewer, pieceType, anchorShape, hr, hc);

    ctx.fillStyle = valid ? THEME.ghostShapeValid : THEME.ghostShapeInvalid;
    for (const [r, c] of Shape.cellsAt(anchorShape, hr, hc)) {
      if (board.isInside(r, c)) {
        ctx.fillRect(c * this.cellSize, r * this.cellSize, this.cellSize, this.cellSize);
      }
    }
  }
}
