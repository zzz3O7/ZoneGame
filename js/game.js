import { createRng } from "./rng.js";
import { Board } from "./board.js";
import { Zone } from "./zone.js";
import { Player } from "./player.js";
import { Rules } from "./rules.js";
import { Shape } from "./shape.js";
import { CaveGenerator } from "./caveGenerator.js";
import { ZONE_RADIUS, STARTING_DOMINOS, PASS_PENALTY } from "./config.js";

export class Game {
  constructor(cols, rows, seed = Date.now()) {
    this.seed = seed;
    const rng = createRng(seed);

    const grid = CaveGenerator.generate(rows, cols, 0.6, rng, 3, 0.4, 0.6, 30);
    const bonusMarkers = CaveGenerator.placeBonusMarkers(grid, 5, 6, rng);

    this.board = new Board(grid, bonusMarkers);
    this.zones = [];
    this.players = [new Player(0, "Player 1", STARTING_DOMINOS), new Player(1, "Player 2", STARTING_DOMINOS)];
    this.currentPlayerIndex = 0;
    this.consecutivePasses = 0;
    this.gameOver = false;
  }

  get currentPlayer() {
    return this.players[this.currentPlayerIndex];
  }

  canCurrentPlayerMove() {
    return Rules.canPlayerMove(this.board, this.zones, this.currentPlayer);
  }

  attemptPlacement(pieceType, shape, anchorRow, anchorCol) {
    if (this.gameOver) return false;
    const player = this.currentPlayer;

    const canPlace = Rules.canPlaceHere(this.board, this.zones, player, pieceType, shape, anchorRow, anchorCol);
    if (!canPlace) return false;

    if (pieceType === "domino") player.useDomino();
    this.board.occupy(Shape.cellsAt(shape, anchorRow, anchorCol));

    const zoneId = this.board.zoneIdAt(anchorRow, anchorCol);
    if (zoneId === null) {
      Zone.create(this.board, this.zones, anchorRow, anchorCol, this.currentPlayerIndex, ZONE_RADIUS);
    } else {
      this.zones[zoneId].localTurn = 1 - this.currentPlayerIndex;
    }

    this._checkZoneCompletions();
    this.consecutivePasses = 0;
    this._advanceTurn();
    return true;
  }

  pass() {
    if (this.gameOver) return false;
    if (this.canCurrentPlayerMove()) return false;

    this.currentPlayer.applyPassPenalty(PASS_PENALTY);
    this.consecutivePasses++;

    if (this.consecutivePasses >= 2) {
      this.gameOver = true;
      return true;
    }

    this._advanceTurn();
    return true;
  }

  _advanceTurn() {
    this.currentPlayerIndex = 1 - this.currentPlayerIndex;
  }

  _checkZoneCompletions() {
    for (const zone of this.zones) {
      if (!zone.active) continue;
      const hasMove = Rules.zoneHasMove(this.board, this.zones, zone, this.players[zone.localTurn]);
      if (!hasMove) {
        zone.complete();
        const winnerIndex = 1 - zone.localTurn;
        this.players[winnerIndex].addScore(zone.cost);
      }
    }
  }

  get winnerIndex() {
    const [s0, s1] = this.players.map((p) => p.score);
    if (s0 === s1) return null;
    return s0 > s1 ? 0 : 1;
  }
}
