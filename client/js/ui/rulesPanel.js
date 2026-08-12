import { sound } from "../audio/soundManager.js";

// Page-level modal, but only ever opened from the "How to play" link inside
// #menuScreen — the button lives in that screen's markup, so it's naturally
// only visible (and reachable) while the menu is showing, without this
// module needing to know anything about screen state itself.
export function initRulesPanel() {
  const openBtn = document.getElementById("btnRules");
  const overlay = document.getElementById("rulesOverlay");
  const closeBtn = document.getElementById("btnRulesClose");
  if (!openBtn || !overlay) return;

  function open() {
    overlay.hidden = false;
  }

  function close() {
    overlay.hidden = true;
  }

  openBtn.addEventListener("click", () => {
    sound.uiClick();
    open();
  });
  closeBtn.addEventListener("click", () => {
    sound.uiClick();
    close();
  });
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close(); // scrim click — outside the panel itself
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !overlay.hidden) close();
  });
}
