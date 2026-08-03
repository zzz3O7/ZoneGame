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
  zoneBordersHighlight: "#c6c8c9", // hover state, distinct from the border above
  moveHighlight: "#3fbfc9",
};

export const LAYOUT = {
  canvasResolution: 720,
  bonusFontRatio: 0.5,
};

export const ZONE_RADIUS = 4;
export const STARTING_DOMINOS = 2;
export const PASS_PENALTY = 0.9;
