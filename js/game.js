import { createRng } from "./rng.js";
import { Board } from "./board.js";
import { Zone } from "./zone.js";
import { Player } from "./player.js";
import { Rules } from "./rules.js";
import { Shape } from "./shape.js";
import { CaveGenerator } from "./caveGenerator.js";
import { MoveHistory } from "./history.js";
import { PASS_PENALTY } from "./config.js";

export class Game {
  // params: { mode, boardSize, zoneRadius, startingDominoes, seed? }
  // Always pass a params object built via resolveParams() (js/params.js) —
  // that's what clamps values and fills in mode presets. Game itself trusts
  // whatever it's given, since resolveParams is the single validation point.
  constructor(params) {
    this.mode = params.mode;
    this.boardSize = params.boardSize;
    this.zoneRadius = params.zoneRadius;
    this.startingDominoes = params.startingDominoes;
    this.seed = params.seed ?? Date.now();

    const rng = createRng(this.seed);

    const grid = CaveGenerator.generate(this.boardSize, this.boardSize, 0.6, rng, 3, 0.4, 0.6, 30);
    const bonusMarkers = CaveGenerator.placeBonusMarkers(grid, 5, 6, rng);

    this.board = new Board(grid, bonusMarkers);
    this.zones = [];
    this.players = [
      new Player(0, "Player 1", params.startingDominoes),
      new Player(1, "Player 2", params.startingDominoes),
    ];
    this.currentPlayerIndex = 0;
    this.gameOver = false;
    this.history = new MoveHistory();
  }

  get currentPlayer() {
    return this.players[this.currentPlayerIndex];
  }

  canCurrentPlayerMove() {
    return Rules.canPlayerMove(this.board, this.zones, this.currentPlayer);
  }

  attemptPlacement(pieceType, shape, anchorRow, anchorCol) {
    if (this.gameOver) return null;
    const player = this.currentPlayer;

    const canPlace = Rules.canPlaceHere(this.board, this.zones, player, pieceType, shape, anchorRow, anchorCol);
    if (!canPlace) return null;

    if (pieceType === "domino") player.useDomino();
    this.board.occupy(Shape.cellsAt(shape, anchorRow, anchorCol));

    const existingZoneId = this.board.zoneIdAt(anchorRow, anchorCol);
    let zoneEvent;
    if (existingZoneId === null) {
      const zone = Zone.create(this.board, this.zones, anchorRow, anchorCol, this.currentPlayerIndex, this.zoneRadius);
      zoneEvent = { kind: "created", zoneId: zone.id };
    } else {
      this.zones[existingZoneId].localTurn = 1 - this.currentPlayerIndex;
      zoneEvent = { kind: "joined", zoneId: existingZoneId };
    }

    const completions = this._checkZoneCompletions();

    const entry = this.history.record({
      playerIndex: this.currentPlayerIndex,
      type: "piece",
      pieceType,
      shape,
      anchorRow,
      anchorCol,
      zoneEvent,
      completions,
    });

    /*
    console.log(`type: ${entry.type}, ${entry.pieceType}\n
      zone ${entry.zoneEvent.zoneId} ${entry.zoneEvent.kind}\n
      completions: ${JSON.stringify(entry.completions)}`); // DEBUG
    */

    this._checkGameEnd();
    this._advanceTurn();
    return entry;
  }

  pass() {
    if (this.gameOver) return null;
    if (this.canCurrentPlayerMove()) return null;

    const playerIndex = this.currentPlayerIndex;
    const preScore = this.currentPlayer.score;
    this.currentPlayer.applyPassPenalty(PASS_PENALTY);
    const penalty = preScore - this.currentPlayer.score;

    const entry = this.history.record({ playerIndex, type: "pass", penalty });
    //console.log(`type: ${entry.type}, penalty: ${entry.penalty}`); // DEBUG

    this._advanceTurn();
    this._checkGameEnd();
    return entry;
  }

  _advanceTurn() {
    this.currentPlayerIndex = 1 - this.currentPlayerIndex;
  }

  _checkZoneCompletions() {
    const completions = [];
    for (const zone of this.zones) {
      if (!zone.active) continue;
      const hasMove = Rules.zoneHasMove(this.board, this.zones, zone, this.players[zone.localTurn]);
      if (!hasMove) {
        zone.complete();
        const winnerIndex = 1 - zone.localTurn;
        this.players[winnerIndex].addScore(zone.cost);
        completions.push({ zoneId: zone.id, winnerIndex, points: zone.cost });
      }
    }
    return completions;
  }

  _checkGameEnd() {
    const noOneCanMove = this.players.every((player) => !Rules.canPlayerMove(this.board, this.zones, player));
    if (noOneCanMove) this.gameOver = true;
  }

  get winnerIndex() {
    const [s0, s1] = this.players.map((p) => p.score);
    if (s0 === s1) return null;
    return s0 > s1 ? 0 : 1;
  }

  getStateHash() {
    const occupied = [...this.board.occupied].sort();
    const zonesState = this.zones.map((z) => `${z.id}:${z.active ? 1 : 0}:${z.localTurn}:${z.cost}`);
    const playersState = this.players.map((p) => `${p.score}:${p.dominoLeft}`);

    const str = JSON.stringify({
      occupied,
      zones: zonesState,
      players: playersState,
      currentPlayerIndex: this.currentPlayerIndex,
      gameOver: this.gameOver,
    });

    // FNV-1a, fast & deterministic, non-crypto
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16);
  }
}
