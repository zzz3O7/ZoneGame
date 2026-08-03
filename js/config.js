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
};

export const PASS_PENALTY = 0.9; // global, not mode-tunable (yet)

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
