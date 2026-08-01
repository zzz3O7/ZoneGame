const GLYPH_SPANS = { domino: 2, tromino: 3, tetromino: 4 };

export class HistoryPanel {
  constructor(container) {
    this.container = container;
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
  // completions, pass penalty) into one total per column -- this is what
  // lets the panel always show two fixed chip slots instead of a variable
  // list, per row
  _totals(entry, baseIndex) {
    const totals = { a: 0, b: 0 };

    if (entry.type === "pass") {
      const side = entry.playerIndex === baseIndex ? "a" : "b";
      totals[side] = -entry.penalty;
      return totals;
    }

    for (const completion of entry.completions) {
      const side = completion.winnerIndex === baseIndex ? "a" : "b";
      totals[side] += completion.points;
    }
    return totals;
  }

  _buildChipSlot(value, side) {
    const slot = document.createElement("div");
    slot.className = "mh-chip-slot";

    if (value !== 0) {
      const isPenalty = value < 0;
      const chip = document.createElement("span");
      chip.className = `mh-chip ${isPenalty ? "mh-chip--penalty" : `mh-chip--${side}`}`;
      chip.textContent = (value > 0 ? "+" : "") + value;
      slot.appendChild(chip);
    }

    return slot;
  }
}
