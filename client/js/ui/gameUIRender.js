import { Zone } from "../../../shared/engine/zone.js";
import { Board } from "../../../shared/engine/board.js";
import { PASS_PENALTY } from "../../../shared/config.js";

// Owns re-deriving the DOM/canvas from GameUI state: the full render()
// cycle plus every sync*() piece of it, and the cheap renderHover() path
// for pointer movement. Reads/writes directly on `ui`.
export class RenderSync {
  constructor(ui) {
    this.ui = ui;
  }

  // ===================== render: fully re-derive the DOM from state =====================

  // Full re-sync: everything that can only change on an actual game-state
  // event (placement, pass, selection/rotation/flip, gesture lifecycle,
  // remote move applied, game over). Never call this from hover/pointer
  // movement — see renderHover below.
  render() {
    const { ui } = this;
    ui._lowTimeWarned = { 0: false, 1: false }; // fresh turn cycle — see ClockController._renderClockFor
    ui.renderer.setWaiting(!ui.game.gameOver && !ui._isMyTurn());
    this.syncStaticCanvas();
    this.syncCanvas();
    this.syncControls();
    this.syncSidePlates();
    ui.endcard.syncGameOver();
    ui.clockCtrl.tickClocks();

    const baseIndex = ui.matchClient ? ui.matchClient.myPlayerIndex : 0;
    ui.historyPanel.render(ui.game.history.all(), baseIndex);
  }

  // Board grid, zone fills/borders, placed pieces — the static layer.
  // Redrawn only here, i.e. only on a genuine game-state event, never on
  // hover/rotate/flip/selection.
  syncStaticCanvas() {
    const { ui } = this;
    const viewerIndex = ui.matchClient
      ? ui.matchClient.myPlayerIndex
      : ui.game.gameOver
        ? 0
        : ui.game.currentPlayerIndex;
    ui.renderer.renderStatic(ui.game.board, ui.game.zones, viewerIndex, ui.game.history.all(), ui.game.gameOver);
  }

  // Cheap path for pointer movement (hover/clearHover). Only touches what
  // cursor position can actually affect: the canvas (ghost/zone-preview/
  // tooltip) and the confirm/discard buttons. Everything else in
  // render() — history panel rebuild, piece-selector buttons, side plates,
  // game-over overlay — is invariant under hover and would just be wasted
  // DOM/canvas work on every mousemove.
  renderHover() {
    this.syncCanvas();
    this.syncStagedButtons();
  }

  syncCanvas() {
    const { ui } = this;
    const staged = ui.input.stagedPlacement();
    const [anchorCell, anchorShape] = staged ? [[staged.anchorRow, staged.anchorCol], staged.shape] : [null, null];
    const pieceType = staged ? staged.type : ui.selectedType;
    const viewerIndex = ui.matchClient ? ui.matchClient.myPlayerIndex : ui.game.currentPlayerIndex;

    const zonePreview = anchorCell
      ? Zone.preview(ui.game.board, anchorCell[0], anchorCell[1], ui.game.zoneRadius)
      : null;
    const cursorInPreview =
      zonePreview && ui.cursorCell && zonePreview.cellSet.has(Board.key(ui.cursorCell[0], ui.cursorCell[1]));

    const entries = ui.game.history.all();
    const highlightIndex = ui.hoveredMoveIndex;
    const highlightEntry = highlightIndex != null && highlightIndex >= 0 ? entries[highlightIndex] : null;

    ui.renderer.renderDynamic(
      ui.game.board,
      ui.game.zones,
      ui.game.currentPlayerIndex,
      ui.game.players[viewerIndex],
      pieceType,
      anchorShape,
      anchorCell,
      ui.cursorCell,
      ui.gesture.path,
      highlightEntry,
      ui.hoveredZoneIds,
      zonePreview,
      ui.selectedType === "calc" ? ui.calcDrawing.displayStrokes : null,
    );

    // Once the game's over, the tooltip should track whether the board is
    // actually visible — not gameOver by itself. While the endcard is up,
    // the board's covered and hovering it doesn't mean anything; once
    // peeking (see EndcardController.toggleBoardPeek), it's just the
    // board again and the cost tooltip is exactly as useful as mid-game.
    const tooltipBoardVisible = !ui.game.gameOver || ui._peekingBoard;
    ui.zoneTooltip.update(
      tooltipBoardVisible ? ui.cursorCell : null,
      ui.game.board,
      ui.game.zones,
      tooltipBoardVisible && cursorInPreview ? zonePreview : null,
    );
  }

  syncControls() {
    this.syncPieceButtons();
    this.syncStagedButtons();
    this.syncOnlineActions();
    this.syncLocalActions();
    this.syncCalcControls();
  }

  // Undo/redo/clear row: visible only while calc mode is the active
  // selection, enablement follows CalcDrawing's own undo/redo stacks.
  syncCalcControls() {
    const { ui } = this;
    const row = document.getElementById("calcControls");
    if (row) row.hidden = ui.selectedType !== "calc";
    const undoBtn = document.getElementById("btnCalcUndo");
    const redoBtn = document.getElementById("btnCalcRedo");
    const clearBtn = document.getElementById("btnCalcClear");
    if (undoBtn) undoBtn.disabled = !ui.calcDrawing.canUndo;
    if (redoBtn) redoBtn.disabled = !ui.calcDrawing.canRedo;
    if (clearBtn) clearBtn.disabled = ui.calcDrawing.isEmpty;
  }

  // Resign is only meaningful for an online match that's still live —
  // hidden entirely in local hotseat, and hidden again once the game ends
  syncOnlineActions() {
    const { ui } = this;
    const el = document.getElementById("onlineMatchActions");
    if (el) el.hidden = !ui.matchClient || ui.game.gameOver;
  }

  // Mirrors syncOnlineActions above, but for local hotseat's
  // mid-game "Back to menu" — hotseat has no forfeit concept, so this is
  // always safe to show while a local game is live. Hidden once the game
  // ends since the endcard's own "Back to menu" covers that case.
  syncLocalActions() {
    const { ui } = this;
    const el = document.getElementById("localMatchActions");
    if (el) el.hidden = !!ui.matchClient || ui.game.gameOver;
  }

  // Piece-type buttons + skip button: depend on selectedType, dominoLeft,
  // turn/gameOver state — never on cursorCell. Only needs to run after
  // real game/selection events, not on every hover.
  //
  // Piece-type buttons reflect the VIEWER's own pieces, not whoever's turn it currently is
  // In local hotseat, viewer === currentPlayer, so this is unchanged there.
  syncPieceButtons() {
    const { ui } = this;
    const viewerIndex = ui.matchClient ? ui.matchClient.myPlayerIndex : ui.game.currentPlayerIndex;
    const viewerPlayer = ui.game.players[viewerIndex];
    const canMove = ui.game.canCurrentPlayerMove();
    const myTurn = ui._isMyTurn(); // true always in local mode, real check online

    document.querySelectorAll(".piece-selector button[data-type]").forEach((btn) => {
      const type = btn.dataset.type;
      const disabled = ui.game.gameOver || (type === "domino" && viewerPlayer.dominoLeft <= 0);
      btn.disabled = disabled;
      btn.classList.toggle("piece-btn--selected", type === ui.selectedType);
    });

    const skipBtn = document.querySelector(".piece-btn--skip");
    if (skipBtn) {
      const forcedSkip = ui.game.gameOver ? false : myTurn && !canMove;
      skipBtn.disabled = ui.game.gameOver || !myTurn || canMove;
      // Only the viewer's own forced-pass state should flash — reusing
      // the same condition the disabled check above already computes.
      skipBtn.classList.toggle("piece-btn--skip-reminder", forcedSkip);
      const skipPenalty = viewerPlayer.score - Math.floor(viewerPlayer.score * PASS_PENALTY);
      const countEl = skipBtn.querySelector(".piece-btn__count");
      if (countEl) countEl.textContent = `-${skipPenalty}`;
    }
  }

  // Confirm/discard buttons: hasStaged depends on cursorCell for non-gesture
  // piece types (mouse hover alone stages a placement, same as touch), so
  // this DOES need to run on hover — kept separate from syncPieceButtons
  // so hover doesn't pay for the querySelectorAll piece-button loop too.
  syncStagedButtons() {
    const { ui } = this;
    const myTurn = ui._isMyTurn();
    const hasStaged = !!ui.input.stagedPlacement();
    const confirmBtn = document.getElementById("btnConfirm");
    const discardBtn = document.getElementById("btnDiscard");
    if (confirmBtn) confirmBtn.disabled = ui.game.gameOver || !myTurn || !hasStaged;
    if (discardBtn) discardBtn.disabled = ui.game.gameOver || !hasStaged;
  }

  syncSidePlates() {
    const { ui } = this;
    const myIndex = ui.matchClient ? ui.matchClient.myPlayerIndex : 0; // local: doesn't matter, arbitrary anchor
    ui.game.players.forEach((player) => {
      const isSelf = player.id === myIndex;
      this._syncSidePlate(player, isSelf);
    });
  }

  _syncSidePlate(player, isSelf) {
    const { ui } = this;
    const plate = document.querySelector(`.side-plate[data-position="${isSelf ? "self" : "opponent"}"]`);
    if (!plate) return;

    const isActive = player.id === ui.game.currentPlayerIndex;
    plate.classList.toggle("side-plate--active", isActive);

    const nameEl = plate.querySelector(".side-plate__name");
    if (nameEl) {
      nameEl.textContent = ui.matchClient?.playerNames?.[player.id] ?? `player_${player.id + 1}`;
    }

    const ratingEl = plate.querySelector(".side-plate__rating");
    if (ratingEl) {
      const rating = ui.matchClient?.rated ? ui.matchClient.playerRatings?.[player.id] : null;
      ratingEl.hidden = rating == null;
      if (rating != null) ratingEl.textContent = rating;
    }

    const scoreEl = plate.querySelector(".side-plate__score");
    if (scoreEl) scoreEl.textContent = player.score;

    const dominoCountEl = plate.querySelector('.side-piece__count[data-piece="domino"]');
    if (dominoCountEl) dominoCountEl.textContent = player.dominoLeft;
  }
}
