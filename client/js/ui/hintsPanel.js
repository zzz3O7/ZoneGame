import { sound } from "../audio/soundManager.js";

export function initHintsPanel() {
  const toggle = document.querySelector(".hints__toggle");
  const body = document.getElementById("hintsBody");
  if (!toggle || !body) return;

  toggle.addEventListener("click", () => {
    sound.uiClick();
    const wasExpanded = !body.hidden;
    body.hidden = wasExpanded;
    toggle.textContent = wasExpanded ? "Expand" : "Collapse";
    toggle.setAttribute("aria-expanded", String(!wasExpanded));
  });
}
