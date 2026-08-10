export class MoveHistory {
  constructor() {
    this.entries = [];
  }

  // data is everything except index, which MoveHistory owns (position in the log)
  record(data) {
    const entry = { index: this.entries.length, ...data };
    this.entries.push(entry);
    return entry;
  }

  all() {
    return this.entries;
  }

  last() {
    return this.entries[this.entries.length - 1] ?? null;
  }
}
