// Deliberately the simplest possible matchmaking: two separate FIFO
// queues (rated / unrated), no skill-based pairing, no params
// negotiation — the pair just gets the first-in player's requested
// params. Artem is building the real matchmaking logic himself later;
// this exists only so "matchmaking" mode has something working
// end-to-end to build on top of.
export class MatchmakingQueue {
  constructor() {
    this.unrated = []; // { ws, nickname, accountPlayerId, params }
    this.rated = [];
  }

  // Adds this ws to the requested queue and returns a matched
  // [entryA, entryB] pair if one just formed, or null if still waiting.
  join(ws, entry, rated) {
    this.leave(ws); // guard against a double JOIN_QUEUE queuing twice
    const queue = rated ? this.rated : this.unrated;
    queue.push({ ws, ...entry });
    if (queue.length >= 2) return [queue.shift(), queue.shift()];
    return null;
  }

  leave(ws) {
    this.unrated = this.unrated.filter((e) => e.ws !== ws);
    this.rated = this.rated.filter((e) => e.ws !== ws);
  }
}
