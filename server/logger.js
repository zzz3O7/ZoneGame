// Minimal human-readable server logging: one line per significant
// lifecycle event. Deliberately no per-move logging.

export function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
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
