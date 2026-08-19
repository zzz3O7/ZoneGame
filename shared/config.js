// Canvas can't read CSS custom properties, so these hex values are copied
// by hand from the :root tokens in style.css. Keep them in sync manually.
export const THEME = {
  floor: "#242c34",
  wall: "#10141a", // walls match --color-bg, so they recede into the page
  wallBonus: "#3a2f14",
  bonusText: "#d3a94a",
  gridLine: "#07080a",
  piece: "#10141a", // same as wall: pieces read as solid/permanent, like walls
  gesturePath: "rgba(231,233,230,0.25)",
  ghostShapeValid: "rgba(126,166,102,0.5)",
  ghostShapeInvalid: "rgba(184,89,63,0.45)",
  pendingNewZone: "rgba(79,143,196,0.18)",
  pendingBonuses: "rgba(211,169,74,0.5)",
  availibleZone: "rgba(126,166,102,0.22)",
  unavailibleZone: "rgba(184,89,63,0.22)",
  inactiveZone: "rgba(92,101,112,0.2)",
  zoneBorders: "#7d8896", // bright on purpose: must hold up over any zone fill
  zoneBordersHighlight: "#dee0e2", // hover state, distinct from the border above
  moveHighlight: "#3fbfc9",
  calcMarkSelf: "rgba(155,110,220,0.5)",
  calcMarkOpponent: "rgba(224,110,180,0.5)",
};

export const LAYOUT = {
  canvasResolution: 720,
  bonusFontRatio: 0.5,
  maxZoom: 4, // pinch-zoom ceiling on the board (mobile), 1 = fit-to-view
  maxCanvasDimension: 4096, // conservative cap: some mobile GPUs clip/blank canvases above ~4096-8192px/side

  // Line widths / insets as a fraction of cellSize instead of fixed px.
  gridLineRatio: 1 / 36,
  zoneBorderRatio: 2 / 36,
  zoneBorderHighlightRatio: 3 / 36,
  moveHighlightRatio: 3 / 36,
  pieceInsetRatio: 3 / 36,
};

export const PASS_PENALTY = 0.7; // global, not mode-tunable (yet)

// How long a match stays alive after a player disconnects before the server
// gives up and aborts it. Server-only concern.
export const DISCONNECT_ABORT_MS = 60_000;

// How long the server waits for the second player to also request a
// rematch before giving up and telling the first requester it fizzled.
export const REMATCH_TIMEOUT_MS = 20_000;

// Fixed presets. Adding a new mode later = one more entry here, nothing else changes.
export const MODES = {
  classic: { label: "Classic", boardSize: 20, zoneRadius: 4, startingDominoes: 2 },
};

// Defaults shown in the custom-params panel before the player touches anything.
export const CUSTOM_DEFAULTS = { boardSize: 20, zoneRadius: 4, startingDominoes: 2 };

// Inclusive [min, max] per custom field. Enforced both client-side (menu.js)
// and server-side (Match) so a modified client can't send out-of-range values.
export const CUSTOM_LIMITS = {
  boardSize: [8, 40],
  zoneRadius: [3, 10],
  startingDominoes: [0, 10],
};

// Time control: orthogonal to board mode (classic/custom) — either can be
// paired with any of these.
export const TIME_PRESETS = {
  none: { label: "No clock", initialMs: null, incrementMs: null },
  bullet: { label: "Bullet · 3+1", initialMs: 180_000, incrementMs: 1000 },
  blitz: { label: "Blitz · 5+3", initialMs: 300_000, incrementMs: 3000 },
  rapid: { label: "Rapid · 10+5", initialMs: 600_000, incrementMs: 5_000 },
  classical: { label: "Classical · 30+20", initialMs: 1_800_000, incrementMs: 20_000 },
};

// Defaults shown in the custom time-control panel before the player touches anything.
export const TIME_CUSTOM_DEFAULTS = { initialMs: 300_000, incrementMs: 0 };

// Inclusive [min, max] for a custom time control, in ms. 15s minimum bank,
// 60min maximum; 0-60s increment. Enforced both client- and server-side,
// same as CUSTOM_LIMITS above.
export const TIME_CUSTOM_LIMITS = {
  initialMs: [15_000, 3_600_000],
  incrementMs: [0, 60_000],
};

// Time control choices offered specifically in matchmaking (Quick Play /
// Ranked) — a stranger match always needs a clock, so "none" and "custom"
// (both only meaningful for local/invite play) are excluded. "any" isn't a
// real time control itself, it's a matchmaking preference: the server
// resolves it to whichever specific preset it gets paired against, falling
// back to MATCHMAKING_ANY_FALLBACK if two "any" queuers pair with nothing
// specific to inherit. Shared so client (queue UI) and server (queue
// validation/pairing) agree on the exact same set of valid keys.
export const MATCHMAKING_TIME_MODES = ["bullet", "blitz", "rapid", "classical", "any"];
export const MATCHMAKING_ANY_FALLBACK = "blitz";

// Rating-aware queue pairing. Acceptance is expressed as a deviation from
// a 50% predicted win probability (see rating.js's winProbability) rather
// than a raw mu difference — that stays meaningful regardless of a
// player's sigma or a future TAU_GLOBAL retune, since it's already the
// outcome-space conversion of a mu gap, not the gap itself. A waiting
// entry's acceptable deviation widens with elapsed wait time and is
// capped at 0.5 (a pure coinflip — i.e. "accept anyone").
//
// Calibrated so a 200-mu-point gap between two fully-converged players
// (sigma near SIGMA_MIN) starts out acceptable (~0.12 deviation at
// TAU_GLOBAL=460), and the window is fully open (deviation clamps to
// 0.5) after roughly 10 seconds of waiting — this project is still in
// development, so fast pairing matters more than pairing precision.
// Tune directly if real play feels off once there's actual queue traffic.
export const MATCHMAKING_WINDOW_BASE_DEVIATION = 0.1;
export const MATCHMAKING_WINDOW_GROWTH_PER_SEC = 0.02;

// A pairing between a known-rated player and a guest (no known rating)
// has nothing comparable to score on the usual deviation-from-coinflip
// scale, so it's given this fixed sentinel score instead — deliberately
// worse than a genuinely good rated match, but better than a genuinely
// bad one. 0.3 deviation corresponds to roughly an 80/20 predicted win
// split: a known opponent worse than that (e.g. a ~90/10 mismatch) is
// considered a worse pick than rolling the dice on an unrated stranger;
// a known opponent better than that still wins out. Two guests pairing
// with each other score 0 (best) — there's no asymmetry there to weigh.
export const MATCHMAKING_UNKNOWN_OPPONENT_SCORE = 0.25;

// How often the queue re-checks everyone still waiting for a now-widened
// match, independent of new players joining — see matchmakingQueue.js's
// sweep(). Cheap at any realistic queue size (see design discussion),
// so this can stay aggressive.
export const MATCHMAKING_SWEEP_INTERVAL_MS = 1000;
