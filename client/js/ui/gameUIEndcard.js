// The "reason" a match ended, for the endcard's reason line.
// "resign" isn't here — it's inherently viewer-relative
// ("You resigned" vs "Opponent resigned"), so it's computed dynamically in _endReasonText.
const END_REASON_TEXT = {
  "no-moves": "No more moves available",
  abort: "Opponent disconnected and didn't return",
  timeout: "On time",
};

// Owns the end-of-match display (overlay, header, scores, breakdown) and
// the online rematch prompt flow. Reads/writes directly on `ui`.
export class EndcardController {
  constructor(ui) {
    this.ui = ui;
  }

  // End the match from outside the normal move flow. Deliberately not
  // touching ui.game.winnerIndex — that getter is a score comparison and
  // a forfeit winner is a different concept. The override lives alongside the game,
  // not inside it, and only affects the endcard header.
  showForcedEnd({ reason, winnerIndex }) {
    const { ui } = this;
    ui._endOverride = { reason, winnerIndex };
    ui.game.gameOver = true;
    ui.render.render();
  }

  syncGameOver() {
    const { ui } = this;
    const overlay = document.getElementById("gameOverOverlay");
    const peekBtn = document.getElementById("btnPeekBoard");
    if (!overlay) return;

    if (!ui.game.gameOver) {
      overlay.hidden = true;
      if (peekBtn) {
        peekBtn.hidden = true;
        peekBtn.setAttribute("aria-pressed", "false");
        peekBtn.title = "Hide end screen to see the board";
      }
      return;
    }
    // Peek button only makes sense once there's an endcard to hide/show —
    // shown here (not just left permanently visible) so it can't be
    // clicked mid-game and appears exactly when the overlay itself does.
    if (peekBtn) peekBtn.hidden = false;
    overlay.hidden = ui._peekingBoard;

    if (!ui._gameOverSoundPlayed) {
      ui._gameOverSoundPlayed = true;
      // Online: viewer's own seat. Hotseat: whoever made the last move —
      // the game ends immediately after a move, so that's the natural
      // "current player" to frame the win/lose sound from.
      const viewerIndex = ui.matchClient ? ui.matchClient.myPlayerIndex : (ui.game.history.last()?.playerIndex ?? 0);
      const winner = ui._endOverride ? ui._endOverride.winnerIndex : ui.game.winnerIndex;
      ui.sound.gameOver(winner === null ? "draw" : winner === viewerIndex ? "win" : "lose");
    }

    this._syncEndcardHeader();
    this._syncEndcardScores();
    this._syncEndcardRating();
    this._syncEndcardBreakdown();
    this._syncEndcardActions();
  }

  _syncEndcardHeader() {
    const { ui } = this;
    const winner = ui._endOverride ? ui._endOverride.winnerIndex : ui.game.winnerIndex;
    const winnerEl = document.getElementById("endcardWinner");
    const reasonEl = document.getElementById("endcardReason");
    const myIndex = ui.matchClient ? ui.matchClient.myPlayerIndex : 0;

    if (winnerEl) {
      if (winner === null || winner === undefined) {
        winnerEl.textContent = "Draw";
      } else {
        const cls = winner === myIndex ? "name-a" : "name-b";
        winnerEl.innerHTML = `<span class="${cls}">${this._playerName(winner)}</span> wins`;
      }
    }
    if (reasonEl) {
      reasonEl.textContent = ui._endOverride
        ? this._endReasonText(ui._endOverride.reason, ui._endOverride.winnerIndex, myIndex)
        : END_REASON_TEXT["no-moves"];
    }
  }

  _endReasonText(reason, winnerIndex, myIndex) {
    if (reason === "resign") {
      return winnerIndex === myIndex ? "Opponent resigned" : "You resigned";
    }
    return END_REASON_TEXT[reason] ?? "Match ended";
  }

  _syncEndcardScores() {
    const { ui } = this;
    const myIndex = ui.matchClient ? ui.matchClient.myPlayerIndex : 0;
    const opponentIndex = 1 - myIndex;
    const winner = ui._endOverride ? ui._endOverride.winnerIndex : ui.game.winnerIndex;

    const nameA = document.getElementById("scoreNameA");
    const nameB = document.getElementById("scoreNameB");
    const valueA = document.getElementById("scoreValueA");
    const valueB = document.getElementById("scoreValueB");
    const sideA = document.querySelector('.score-side[data-side="a"]');
    const sideB = document.querySelector('.score-side[data-side="b"]');

    if (nameA) nameA.textContent = this._playerName(myIndex);
    if (nameB) nameB.textContent = this._playerName(opponentIndex);
    if (valueA) valueA.textContent = ui.game.players[myIndex].score;
    if (valueB) valueB.textContent = ui.game.players[opponentIndex].score;
    sideA?.classList.toggle("winner", winner === myIndex || winner === null);
    sideB?.classList.toggle("winner", winner === opponentIndex || winner === null);
  }

  // Rated-only. Rides on the same viewer-relative A/B split as
  // _syncEndcardScores. matchClient.ratingUpdate is populated by
  // MSG.RATING_UPDATE — it always arrives before the message that actually
  // triggers this render (see matchClient.js), so by the time syncGameOver()
  // runs it's either already there or this genuinely wasn't a rated game.
  _syncEndcardRating() {
    const { ui } = this;
    const changeA = document.getElementById("ratingChangeA");
    const changeB = document.getElementById("ratingChangeB");
    if (!changeA || !changeB) return;

    const update = ui.matchClient?.rated ? ui.matchClient.ratingUpdate : null;
    if (!update) {
      changeA.hidden = true;
      changeB.hidden = true;
      return;
    }

    this._renderRatingChange(changeA, update.ratingBefore, update.ratingAfter);
    this._renderRatingChange(changeB, update.opponentRatingBefore, update.opponentRatingAfter);
  }

  _renderRatingChange(el, before, after) {
    if (before == null || after == null) {
      el.hidden = true;
      return;
    }
    const delta = after - before;
    const sign = delta >= 0 ? "+" : "";
    el.textContent = `${after} (${sign}${delta})`;
    el.classList.toggle("pos", delta >= 0);
    el.classList.toggle("neg", delta < 0);
    el.hidden = false;
  }

  _syncEndcardBreakdown() {
    const { ui } = this;
    const columnA = document.getElementById("breakdownColumnA");
    const columnB = document.getElementById("breakdownColumnB");
    if (!columnA || !columnB) return;

    const myIndex = ui.matchClient ? ui.matchClient.myPlayerIndex : 0;
    const opponentIndex = 1 - myIndex;

    const rowsByPlayer = [[], []];
    for (const entry of ui.game.history.all()) {
      if (entry.type === "piece") {
        for (const completion of entry.completions) {
          rowsByPlayer[completion.winnerIndex].push({
            label: `Zone #${completion.zoneId + 1} completed`,
            points: completion.points,
          });
        }
      } else if (entry.type === "pass" && entry.penalty > 0) {
        rowsByPlayer[entry.playerIndex].push({ label: "Pass penalty", points: -entry.penalty });
      }
    }

    this._renderBreakdownColumn(columnA, rowsByPlayer[myIndex]);
    this._renderBreakdownColumn(columnB, rowsByPlayer[opponentIndex]);
  }

  _renderBreakdownColumn(container, rows) {
    container.innerHTML = "";

    if (rows.length === 0) {
      const empty = document.createElement("div");
      empty.className = "breakdown__empty";
      empty.textContent = "No scoring events.";
      container.appendChild(empty);
      return;
    }

    for (const row of rows) {
      const el = document.createElement("div");
      el.className = "breakdown__row";
      const sign = row.points >= 0 ? "+" : "";
      el.innerHTML = `
        <span class="label">${row.label}</span>
        <span class="pts ${row.points >= 0 ? "pos" : "neg"}">${sign}${row.points}</span>
      `;
      container.appendChild(el);
    }
  }

  _syncEndcardActions() {
    const { ui } = this;
    // Rematch/same-board replay locally by reconstructing Game — no server
    // protocol for this yet, so keep it local-hotseat only for now.
    const localActions = document.getElementById("endcardLocalActions");
    if (localActions) localActions.hidden = !!ui.matchClient;

    // Online rematch — only offered while the match is still alive
    // server-side for it (status "over": a naturally-completed or resigned
    // game). Once it's "aborted" (forfeit-by-disconnect, or the opponent
    // explicitly left), the match is already gone server-side — nothing to
    // rematch, just leave "Back to menu".
    const onlineActions = document.getElementById("endcardOnlineActions");
    if (onlineActions) onlineActions.hidden = !ui.matchClient || ui.matchClient.status !== "over";

    // Fresh endcard render, fresh status — clear any stale "waiting on
    // opponent" text/disabled-button state left over from a previous game.
    this.resetRematchPrompt();
  }

  // Bound to btnOnlineRematch. Symmetric with the opponent's own
  // click — server just waits for both (see Match.requestRematch) and
  // fires a normal MATCH_START once it has them, which the existing
  // onMatchStart -> startGame() path already handles with no further
  // wiring needed here.
  requestRematch() {
    const { ui } = this;
    if (!ui.matchClient || ui.matchClient.status !== "over") return;
    ui.sound.uiConfirm();
    ui.matchClient.requestRematch();
    this.setRematchStatus("Waiting for opponent to accept…");
    const btn = document.getElementById("btnOnlineRematch");
    if (btn) btn.disabled = true;
  }

  // Opponent clicked rematch before we did — nudge, doesn't disable
  // our own button, since clicking it now is exactly how we accept.
  showOpponentWantsRematch() {
    this.setRematchStatus("Opponent wants a rematch — click Rematch to accept!", { active: true });
  }

  // Bound to btnPeekBoard. Purely a visibility toggle on the existing
  // overlay — doesn't touch ui.game or ui._endOverride at all, so the
  // endcard's actual content (winner, scores, breakdown) is exactly as
  // it was the moment the toggle is clicked back off.
  toggleBoardPeek() {
    const { ui } = this;
    ui._peekingBoard = !ui._peekingBoard;
    ui.sound.uiConfirm();

    const overlay = document.getElementById("gameOverOverlay");
    if (overlay) overlay.hidden = ui._peekingBoard;

    const peekBtn = document.getElementById("btnPeekBoard");
    if (peekBtn) {
      peekBtn.setAttribute("aria-pressed", String(ui._peekingBoard));
      peekBtn.title = ui._peekingBoard ? "Show end screen" : "Hide end screen to see the board";
    }

    ui.render.renderHover();
  }

  // Small imperative status-line helper for the online rematch
  // prompt. Event-driven (who clicked/asked what) rather than derived from
  // persistent state like the rest of render(), so it lives outside the
  // normal sync*() cycle and is called directly from main.js's
  // matchClient callbacks as well as from here.
  setRematchStatus(text, { active = false } = {}) {
    const el = document.getElementById("endcardRematchStatus");
    if (!el) return;
    if (!text) {
      el.hidden = true;
      return;
    }
    el.textContent = text;
    el.hidden = false;
    el.classList.toggle("endcard__rematch-status--active", active);
  }

  // Rematch fizzled (timeout) or is otherwise moot — clear the
  // prompt and re-enable the button so they can try again.
  resetRematchPrompt() {
    this.setRematchStatus(null);
    const btn = document.getElementById("btnOnlineRematch");
    if (btn) btn.disabled = false;
  }

  // Fallback when no matchClient (local hotseat) or names aren't loaded yet —
  // Player already carries a default "Player 1"/"Player 2" name.
  _playerName(index) {
    const { ui } = this;
    return ui.matchClient?.playerNames?.[index] ?? ui.game.players[index].name;
  }
}
