// A PlayerAgent is whatever Match talks to on one side of the board.
// Match only ever calls agent.send(msg) — it has no idea whether that's
// a real socket or a bot, and it should never need to know. See
// docs/BOTS.md for the design this exists to support.
//
// Disconnect/reconnect/abort-timeout are deliberately NOT part of this
// interface: they're human-specific concepts that Match itself tracks
// via player.connected, driven by handleDisconnect()/reconnect() being
// called (or not) from index.js. A BotAgent is simply never subject to
// those calls, so it reads as permanently connected without match.js
// needing an `if (isBot)` anywhere.

import { MSG } from "../shared/net/protocol.js";
import { botThinkDelayMs } from "./bot/botTiming.js";
import { BOT_LEAVE_MIN_MS, BOT_LEAVE_RANGE_MS } from "./bot/botConfig.js";

// Wraps a live WebSocket. Guards against a closed/null socket the same
// way the old inline _sendTo helper did.
export class HumanAgent {
  constructor(ws) {
    this.ws = ws;
  }

  send(msg) {
    if (!this.ws || this.ws.readyState !== this.ws.OPEN) return;
    try {
      this.ws.send(JSON.stringify(msg));
    } catch (err) {
      console.error("send failed:", err.message);
    }
  }
}

// A live bot seat. Holds a direct reference to its Match — constructed
// after the Match exists but before either player is added (see
// MatchManager.createPvEMatch), so by the time it starts receiving
// broadcasts (which happens synchronously inside Match.addPlayer's
// _start()), match.game already exists.
//
// chooseMove(game, playerIndex) -> move | null is injected rather than
// hardcoded, so swapping strength tiers (docs/BOTS.md Phase 2) never
// touches this class — only which function gets passed in.
export class BotAgent {
  constructor(match, chooseMove) {
    this.match = match;
    this.chooseMove = chooseMove;
    this._thinkTimer = null;
    this._afterGameTimer = null;
  }

  send(msg) {
    switch (msg.type) {
      case MSG.MATCH_START:
        this._maybeThink();
        break;
      case MSG.MOVE_APPLIED:
        // A natural end (no-moves) signals through here, not a separate
        // MATCH_ENDED — see protocol.js's comment on MATCH_ENDED.
        if (msg.gameOver) this._onGameOver();
        else this._maybeThink();
        break;
      case MSG.MATCH_ENDED:
        // Covers resign/timeout/abort — the endings that don't route
        // through MOVE_APPLIED.
        clearTimeout(this._thinkTimer);
        this._onGameOver();
        break;
      case MSG.OPPONENT_LEFT:
        clearTimeout(this._thinkTimer);
        clearTimeout(this._afterGameTimer);
        break;
      case MSG.OPPONENT_WANTS_REMATCH:
        // direct_debug: always accept, immediately — that's the point
        // of debug mode, rapid iteration against the same opponent. Any
        // other origin ignores this; _onGameOver's own timer leaves
        // regardless of what gets requested in the meantime.
        if (this.match.origin === "direct_debug") this.match.requestRematch(this);
        break;
    }
  }

  // direct_debug always accepts a prompt rematch (see
  // OPPONENT_WANTS_REMATCH) and otherwise just sits there — it doesn't
  // need to time itself out anymore, Match's own post-game idle timer
  // (MATCH_POST_GAME_IDLE_MS) now bounds "nobody ever rematches"
  // uniformly for every match, bot or not. Every other origin still
  // leaves after a short human-ish pause: neither vanishing the instant
  // the game ends nor sitting there for minutes reads as a real player.
  _onGameOver() {
    clearTimeout(this._thinkTimer);
    clearTimeout(this._afterGameTimer);
    if (this.match.origin === "direct_debug") return;

    const delay = BOT_LEAVE_MIN_MS + Math.random() * BOT_LEAVE_RANGE_MS;
    this._afterGameTimer = setTimeout(() => this.match.leave(this), delay);
  }

  _maybeThink() {
    clearTimeout(this._thinkTimer);
    const { match } = this;
    if (match.status !== "active") return;

    const player = match.players.find((p) => p.agent === this);
    if (!player || player.playerIndex !== match.game.currentPlayerIndex) return;

    const delay = botThinkDelayMs({
      clock: match.clock,
      playerIndex: player.playerIndex,
      origin: match.origin,
      now: Date.now(),
    });
    this._thinkTimer = setTimeout(() => this._move(player), delay);
  }

  _move(player) {
    const { match } = this;
    // Stale-timer guard: something else could have ended the game or
    // advanced the turn again in the time this was scheduled to wait.
    if (match.status !== "active" || player.playerIndex !== match.game.currentPlayerIndex) return;

    const move = this.chooseMove(match.game, player.playerIndex);
    if (move) {
      match.attemptMove(this, move.pieceType, move.shape, move.anchorRow, move.anchorCol);
    } else {
      match.attemptPass(this);
    }
  }
}
