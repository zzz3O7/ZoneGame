const GLYPH_SPANS = { domino: 2, tromino: 3, tetromino: 4 };

export class HistoryPanel {
  constructor(container, onMoveHover = () => {}, onChipHover = () => {}, onPanelHover = () => {}) {
    this.container = container;
    this.onMoveHover = onMoveHover;
    this.onChipHover = onChipHover;
    this.onPanelHover = onPanelHover;

    // Same reused-DOM situation as GameUI (see its constructor comment):
    // a new HistoryPanel is created per match against the same container
    // element, so these need to be revocable — otherwise a rematch's old
    // instance keeps firing onPanelHover with its stale game reference.
    this._abort = new AbortController();

    if (this.container) {
      const signal = this._abort.signal;
      this.container.addEventListener("mouseenter", () => this.onPanelHover(true), { signal });
      this.container.addEventListener("mouseleave", () => this.onPanelHover(false), { signal });
    }
  }

  destroy() {
    this._abort.abort();
  }

  // baseIndex is the "blue" player for this view: 0 in hotseat,
  // or matchClient.myPlayerIndex in multiplayer
  // absolute per match, not per-turn.
  render(entries, baseIndex) {
    if (!this.container) return;

    this.container.innerHTML = "";
    for (let i = 0; i < entries.length; i++) {
      this.container.appendChild(this._buildRow(entries[i], i, baseIndex));
    }
    this.container.scrollTop = this.container.scrollHeight;
  }

  _buildRow(entry, index, baseIndex) {
    const row = document.createElement("div");
    row.className = "mh-row";

    const idx = document.createElement("span");
    idx.className = "mh-idx";
    idx.textContent = index + 1;
    row.appendChild(idx);

    const side = entry.playerIndex === baseIndex ? "a" : "b";
    const move = document.createElement("div");
    move.className = `mh-move mh-move--${side}`;
    move.appendChild(this._buildGlyph(entry));
    move.addEventListener("mouseenter", () => this.onMoveHover(index));
    move.addEventListener("mouseleave", () => this.onMoveHover(null));
    row.appendChild(move);

    const totals = this._totals(entry, baseIndex);
    row.appendChild(this._buildChipSlot(totals.a, "a"));
    row.appendChild(this._buildChipSlot(totals.b, "b"));

    return row;
  }

  _buildGlyph(entry) {
    if (entry.type === "pass") {
      const el = document.createElement("span");
      el.className = "mh-glyph-pass";
      el.textContent = "⏭";
      return el;
    }

    const spans = GLYPH_SPANS[entry.pieceType];
    const glyph = document.createElement("span");
    glyph.className = `mh-glyph mh-glyph-${entry.pieceType}`;
    for (let i = 0; i < spans; i++) glyph.appendChild(document.createElement("span"));
    return glyph;
  }

  // combines every score-changing side effect of this entry (zone
  // completions, pass penalty) into one chip-slot per column, plus
  // which zoneIds fed it (for hover highlight) -- this is what lets
  // the panel always show two fixed chip slots instead of a variable
  // list, per row
  _totals(entry, baseIndex) {
    const totals = {
      a: { value: 0, zoneIds: null, visible: false, isPenalty: false },
      b: { value: 0, zoneIds: null, visible: false, isPenalty: false },
    };

    if (entry.type === "pass") {
      const side = entry.playerIndex === baseIndex ? "a" : "b";
      totals[side] = { value: -entry.penalty, zoneIds: null, visible: true, isPenalty: true };
      return totals;
    }

    totals.a.zoneIds = [];
    totals.b.zoneIds = [];

    for (const completion of entry.completions) {
      const side = completion.winnerIndex === baseIndex ? "a" : "b";
      totals[side].value += completion.points;
      totals[side].zoneIds.push(completion.zoneId);
      totals[side].visible = true;
    }
    return totals;
  }

  _buildChipSlot(data, side) {
    const slot = document.createElement("div");
    slot.className = "mh-chip-slot";

    if (data.visible) {
      const chip = document.createElement("span");
      chip.className = `mh-chip ${data.isPenalty ? "mh-chip--penalty" : `mh-chip--${side}`}`;
      chip.textContent = data.isPenalty ? `-${Math.abs(data.value)}` : `+${data.value}`;
      if (data.zoneIds) {
        chip.addEventListener("mouseenter", () => this.onChipHover(new Set(data.zoneIds)));
        chip.addEventListener("mouseleave", () => this.onChipHover(null));
      }
      slot.appendChild(chip);
    }

    return slot;
  }
}
