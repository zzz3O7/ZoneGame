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

// Stub for now — no decision logic yet (see docs/BOTS.md Phase 1).
// Exists so PlayerAgent has a second real implementation instead of an
// interface nobody's checked, and so a bot can be wired into a Match the
// moment there's a bot to wire in, with zero changes to match.js.
export class BotAgent {
  constructor(bot) {
    this.bot = bot;
  }

  send(msg) {
    // Will forward state changes to the bot's think step. No-op until
    // there's a bot on the other end.
  }
}
