export class Player {
  constructor(id, name, dominoCount) {
    this.id = id;
    this.name = name;
    this.score = 0;
    this.dominoLeft = dominoCount;
  }

  availableTypes() {
    const types = ["tromino", "tetromino"];
    if (this.dominoLeft > 0) types.push("domino");
    return types;
  }

  useDomino() {
    this.dominoLeft--;
  }

  addScore(amount) {
    this.score += amount;
  }

  applyPassPenalty(penaltyFactor) {
    this.score = Math.floor(this.score * penaltyFactor);
  }
}
