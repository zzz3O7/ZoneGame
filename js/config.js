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
};

export const LAYOUT = {
  canvasResolution: 720,
  bonusFontRatio: 0.5,
  maxZoom: 4, // pinch-zoom ceiling on the board (mobile), 1 = fit-to-view
  maxCanvasDimension: 4096, // conservative cap: some mobile GPUs clip/blank canvases above ~4096-8192px/side

  // Line widths / insets as a fraction of cellSize instead of fixed px, so
  // a 60x60 custom board doesn't get relatively-huge borders and a 10x10
  // board doesn't get relatively-invisible ones. Ratios derived from the
  // original fixed values (1px/2px/3px/3px/3px) at the classic-mode
  // baseline cellSize (720 canvasResolution / 20 board = 36px), so the
  // classic-mode look is unchanged and everything else now scales with it.
  gridLineRatio: 1 / 36,
  zoneBorderRatio: 2 / 36,
  zoneBorderHighlightRatio: 3 / 36,
  moveHighlightRatio: 3 / 36,
  pieceInsetRatio: 3 / 36,
};

export const PASS_PENALTY = 0.9; // global, not mode-tunable (yet)

// How long a match stays alive after a player disconnects before the server
// gives up and aborts it. Server-only concern, but lives here with the other
// tunables rather than buried in match.js. 10s for testing — bump way up
// (60-90s) before this goes live for real.
export const DISCONNECT_ABORT_MS = 10_000;

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
