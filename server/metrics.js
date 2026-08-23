// Lightweight process + traffic metrics for the admin tool. Deliberately
// no external metrics library — just enough to answer "is the server
// healthy" without SSHing in.

const MESSAGE_WINDOW_MS = 60_000;
let messageTimestamps = [];

// Called from index.js's ws.on("message") for every inbound frame,
// parse-failures included — a flood of malformed messages is exactly
// the kind of thing this should surface, not hide.
export function recordMessage() {
  messageTimestamps.push(Date.now());
  const cutoff = Date.now() - MESSAGE_WINDOW_MS;
  // Opportunistic trim on the hot path rather than a separate timer —
  // this runs on every message anyway, so the array never grows past
  // roughly one window's worth of traffic.
  while (messageTimestamps.length && messageTimestamps[0] < cutoff) messageTimestamps.shift();
}

function messagesPerMinute() {
  const cutoff = Date.now() - MESSAGE_WINDOW_MS;
  // Re-filter rather than trust the opportunistic trim above alone — a
  // read can happen in a quiet stretch where nothing has trimmed recently.
  return messageTimestamps.filter((t) => t >= cutoff).length;
}

// Event loop lag: how much longer than requested a timer actually fires
// late by, sampled continuously via a self-rescheduling setTimeout loop.
// A healthy loop reads near 0ms; rising lag means something's blocking
// the event loop (heavy sync work, GC pressure, etc).
const LAG_SAMPLE_INTERVAL_MS = 500;
let lastLagMs = 0;
function sampleLoop() {
  const scheduledAt = Date.now();
  setTimeout(() => {
    lastLagMs = Math.max(0, Date.now() - scheduledAt - LAG_SAMPLE_INTERVAL_MS);
    sampleLoop();
  }, LAG_SAMPLE_INTERVAL_MS).unref(); // unref so this sampler alone never keeps the process alive
}
sampleLoop();

function round1(n) {
  return Math.round(n * 10) / 10;
}

export function processMetrics() {
  const mem = process.memoryUsage();
  return {
    uptimeSec: Math.round(process.uptime()),
    memory: {
      rssMb: round1(mem.rss / 1e6),
      heapUsedMb: round1(mem.heapUsed / 1e6),
      heapTotalMb: round1(mem.heapTotal / 1e6),
      externalMb: round1(mem.external / 1e6),
    },
    eventLoopLagMs: lastLagMs,
    wsMessagesPerMinute: messagesPerMinute(),
  };
}
