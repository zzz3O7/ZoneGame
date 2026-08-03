import { Shape, SHAPES_BASE } from "./shape.js";
import { PASS_PENALTY, ZONE_RADIUS } from "./config.js";
import { GestureInput } from "./gestureInput.js";
import { ZoneTooltip } from "./zoneTooltip.js";
import { Zone } from "./zone.js";
import { Board } from "./board.js";
import { HistoryPanel } from "./historyPanel.js";

const KEY_TO_TYPE = { 1: "gesture", 2: "domino", 3: "tromino", 4: "tetromino" };

export class GameUI {
  constructor(game, renderer, canvas, matchClient = null) {
    this.game = game;
    this.renderer = renderer;
    this.canvas = canvas;
    this.matchClient = matchClient; // null = local hotseat

    this.selectedType = "gesture";
    this.rotationStep = 0;
    this.flipped = false;
    this.cursorCell = null;

    this.gesture = new GestureInput();
    this.zoneTooltip = new ZoneTooltip(canvas);

    this.hoveredMoveIndex = null;
    this.hoveredZoneIds = null;
    this.historyPanelHovered = false;

    this.historyPanel = new HistoryPanel(
      document.querySelector(".move-history__body"),
      (index) => this.hoverMove(index),
      (zoneIds) => this.hoverZone(zoneIds),
      (active) => this.hoverPanel(active),
    );

    this._bindCanvasEvents();
    this._bindControls();
  }

  init() {
    const seedEl = document.getElementById("seedValue");
    if (seedEl) seedEl.textContent = this.game.seed;
    this._render();
  }

  refresh() {
    // public alias, so main.js can trigger re-render on remote moves
    this._render();
  }

  // ===================== network gating =====================

  _isMyTurn() {
    return !this.matchClient || this.matchClient.isMyTurn();
  }

  _submitPlacement(pieceType, shape, anchorRow, anchorCol) {
    if (!this._isMyTurn()) return;

    if (this.matchClient) {
      this.matchClient.sendMove(pieceType, shape, anchorRow, anchorCol);
      // no local mutation, no _render() here — wait for moveApplied broadcast
    } else {
      this.game.attemptPlacement(pieceType, shape, anchorRow, anchorCol);
      this._render();
    }
  }

  _submitPass() {
    if (!this._isMyTurn()) return;

    if (this.matchClient) {
      this.matchClient.sendPass();
      // same: wait for broadcast, don't mutate/render yet
    } else {
      if (!this.game.pass()) return;
      this._render();
    }
  }

  // ===================== intents: piece selection & transforms =====================

  selectType(type) {
    this.selectedType = type;
    this.rotationStep = 0;
    this.flipped = false;
    this.gesture.reset();
    this._render();
  }

  rotate(direction) {
    this.rotationStep = (this.rotationStep + direction + 4) % 4;
    this._render();
  }

  flip() {
    this.flipped = !this.flipped;
    this._render();
  }

  currentShape() {
    if (this.selectedType === "gesture") return null;
    let cells = SHAPES_BASE[this.selectedType];
    if (this.flipped) cells = Shape.reflect(cells);
    for (let i = 0; i < this.rotationStep; i++) cells = Shape.rotate(cells);
    return cells;
  }

  hoverMove(index) {
    this.hoveredMoveIndex = index;
    this._syncCanvas();
  }

  hoverZone(zoneIds) {
    this.hoveredZoneIds = zoneIds;
    this._syncCanvas();
  }

  hoverPanel(active) {
    this.historyPanelHovered = active;
    if (!active) {
      this.hoveredMoveIndex = null;
      this.hoveredZoneIds = null;
    }
    this._syncCanvas();
  }

  // ===================== intents: gesture drawing =====================

  startGesture(cell) {
    if (this.selectedType !== "gesture") return;
    this.gesture.start(cell);
    this._render();
  }

  finishGesture() {
    if (!this.gesture.finish()) return;
    this._render();
  }

  cancelGesture() {
    this.gesture.cancel();
    this._render();
  }

  confirmGesture() {
    const confirmed = this.gesture.confirm((type, shape, anchorRow, anchorCol) => {
      this._submitPlacement(type, shape, anchorRow, anchorCol);
    });
    //if (confirmed && !this.matchClient) this._render();
    this._render();
  }

  secondaryAction() {
    if (this.selectedType === "gesture") {
      this.cancelGesture();
    } else {
      this.flip();
    }
  }

  // ===================== intents: board interaction =====================

  hover(cell) {
    this.cursorCell = cell;
    this.gesture.extend(cell);
    this._render();
  }

  clearHover() {
    this.cursorCell = null;
    this._render();
  }

  placeAt([row, col]) {
    this._submitPlacement(this.selectedType, this.currentShape(), row, col);
  }

  skipTurn() {
    this._submitPass();
  }

  // ===================== input: DOM event listeners =====================

  _cellFromEvent(event) {
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.width / rect.width;
    const scaleY = this.canvas.height / rect.height;
    const x = (event.clientX - rect.left - this.canvas.clientLeft) * scaleX;
    const y = (event.clientY - rect.top - this.canvas.clientTop) * scaleY;
    const cellSize = this.renderer.cellSize;
    const board = this.game.board;
    const col = Math.min(Math.max(Math.floor(x / cellSize), 0), board.cols - 1);
    const row = Math.min(Math.max(Math.floor(y / cellSize), 0), board.rows - 1);
    return [row, col];
  }

  _bindCanvasEvents() {
    this.canvas.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      this.startGesture(this._cellFromEvent(e));
    });

    document.addEventListener("mouseup", () => this.finishGesture());

    this.canvas.addEventListener("mousemove", (e) => this.hover(this._cellFromEvent(e)));
    this.canvas.addEventListener("mouseleave", () => this.clearHover());

    this.canvas.addEventListener("click", (e) => {
      if (this.gesture.consumeSuppressedClick()) return;
      if (this.gesture.pending) {
        this.confirmGesture();
        return;
      }
      if (this.selectedType === "gesture") return; // nothing drawn/confirmed yet
      this.placeAt(this._cellFromEvent(e));
    });

    this.canvas.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.secondaryAction();
    });

    this.canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      this.rotate(e.deltaY > 0 ? 1 : -1);
    });
  }

  _bindControls() {
    // Single shared control row (lives in the left "Controls" panel) — it
    // always acts on whichever player's turn it currently is.
    document.querySelectorAll(".piece-selector button[data-type]").forEach((btn) => {
      btn.addEventListener("click", () => this.selectType(btn.dataset.type));
    });

    document.querySelectorAll(".piece-btn--skip").forEach((btn) => {
      btn.addEventListener("click", () => this.skipTurn());
    });

    document.addEventListener("keydown", (event) => {
      const type = KEY_TO_TYPE[event.key];
      if (type) {
        this.selectType(type);
        return;
      }
      if (event.key === "r") {
        this.rotate(1);
        return;
      }
      if (event.key === "f") {
        this.secondaryAction();
        return;
      }
    });
  }

  // ===================== render: fully re-derive the DOM from state =====================

  _activePlacement() {
    if (this.gesture.pending) {
      return [[this.gesture.pending.anchorRow, this.gesture.pending.anchorCol], this.gesture.pending.shape];
    }
    if (this.selectedType === "gesture") return [null, null];
    if (!this.cursorCell) return [null, null];
    return [this.cursorCell, this.currentShape()];
  }

  _render() {
    this.canvas.classList.toggle("board--waiting", !this._isMyTurn());
    this._syncCanvas();
    this._syncControls();
    this._syncSidePlates();
    this._syncGameOver();

    const baseIndex = this.matchClient ? this.matchClient.myPlayerIndex : 0;
    this.historyPanel.render(this.game.history.all(), baseIndex);
  }

  _syncCanvas() {
    const [anchorCell, anchorShape] = this._activePlacement();
    const pieceType = this.gesture.pending ? this.gesture.pending.type : this.selectedType;
    const viewerIndex = this.matchClient ? this.matchClient.myPlayerIndex : this.game.currentPlayerIndex;

    const zonePreview = anchorCell ? Zone.preview(this.game.board, anchorCell[0], anchorCell[1], ZONE_RADIUS) : null;
    const cursorInPreview =
      zonePreview && this.cursorCell && zonePreview.cellSet.has(Board.key(this.cursorCell[0], this.cursorCell[1]));

    const entries = this.game.history.all();
    const highlightIndex = this.hoveredMoveIndex;
    const highlightEntry = highlightIndex != null && highlightIndex >= 0 ? entries[highlightIndex] : null;

    this.renderer.render(
      this.game.board,
      this.game.zones,
      this.game.currentPlayerIndex,
      this.game.players[viewerIndex],
      pieceType,
      anchorShape,
      anchorCell,
      this.cursorCell,
      this.gesture.path,
      highlightEntry,
      this.hoveredZoneIds,
      entries,
    );

    this.zoneTooltip.update(this.cursorCell, this.game.board, this.game.zones, cursorInPreview ? zonePreview : null);
  }

  _syncControls() {
    const player = this.game.currentPlayer;
    const canMove = this.game.canCurrentPlayerMove();
    const myTurn = this._isMyTurn(); // true always in local mode, real check online

    document.querySelectorAll(".piece-selector button[data-type]").forEach((btn) => {
      const type = btn.dataset.type;
      const disabled = this.game.gameOver || (type === "domino" && player.dominoLeft <= 0);
      btn.disabled = disabled;
      btn.classList.toggle("piece-btn--selected", type === this.selectedType);
    });

    const skipBtn = document.querySelector(".piece-btn--skip");
    if (skipBtn) {
      skipBtn.disabled = this.game.gameOver || !myTurn || canMove;
      const skipPenalty = player.score - Math.floor(player.score * PASS_PENALTY);
      const countEl = skipBtn.querySelector(".piece-btn__count");
      if (countEl) countEl.textContent = `-${skipPenalty}`;
    }
  }

  _syncSidePlates() {
    const myIndex = this.matchClient ? this.matchClient.myPlayerIndex : 0; // local: doesn't matter, arbitrary anchor
    this.game.players.forEach((player) => {
      const isSelf = player.id === myIndex;
      this._syncSidePlate(player, isSelf);
    });
  }

  _syncSidePlate(player, isSelf) {
    const plate = document.querySelector(`.side-plate[data-position="${isSelf ? "self" : "opponent"}"]`);
    if (!plate) return;

    const isActive = player.id === this.game.currentPlayerIndex;
    plate.classList.toggle("side-plate--active", isActive);

    const nameEl = plate.querySelector(".side-plate__name");
    if (nameEl) {
      nameEl.textContent = this.matchClient?.playerNames?.[player.id] ?? `player_${player.id + 1}`;
    }

    const scoreEl = plate.querySelector(".side-plate__score");
    if (scoreEl) scoreEl.textContent = player.score;

    const dominoCountEl = plate.querySelector('.side-piece__count[data-piece="domino"]');
    if (dominoCountEl) dominoCountEl.textContent = player.dominoLeft;
  }

  _syncGameOver() {
    const overlay = document.getElementById("gameOverOverlay");
    const message = document.getElementById("gameOverMessage");
    if (!overlay || !message) return;

    if (!this.game.gameOver) {
      overlay.hidden = true;
      return;
    }

    const winner = this.game.winnerIndex;
    const winnerName = winner === null ? null : (this.matchClient?.playerNames?.[winner] ?? `player_${winner + 1}`);
    message.textContent = winner === null ? "Draw" : `${winnerName} wins`;
    overlay.hidden = false;
  }
}
