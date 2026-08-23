// Minimal human-readable server logging: one line per significant
// lifecycle event. Deliberately no per-move logging.

// Fixed-size ring buffer of recent formatted lines, kept alongside the
// normal console output (never instead of it) so the admin tool has
// something to read without tailing a file or shelling into the box.
// Bounded so a chatty period can't grow this unboundedly — oldest lines
// just fall off once full.
const RING_CAPACITY = 2000;
const ring = [];

function pushToRing(line) {
  ring.push(line);
  if (ring.length > RING_CAPACITY) ring.shift();
}

// Newest-first, capped at `limit` — that's the order an admin view wants
// (most recent activity at the top) and it avoids handing back 2000
// lines when the caller only wants the last 50.
export function getRecentLogs(limit = 200) {
  const n = Math.min(limit, ring.length);
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = ring[ring.length - 1 - i];
  return out;
}

export function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  pushToRing(line);
}

// UUIDs are unreadable in full — first 8 chars is enough to tell
// matches apart in a log stream.
export function shortId(id) {
  return id ? id.slice(0, 8) : id;
}

export function formatDuration(ms) {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m${s}s`;
}
