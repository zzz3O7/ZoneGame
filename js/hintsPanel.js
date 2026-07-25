document.addEventListener("DOMContentLoaded", () => {
  const toggle = document.querySelector(".hints__toggle");
  const body = document.getElementById("hintsBody");
  if (!toggle || !body) return;

  toggle.addEventListener("click", () => {
    const wasExpanded = !body.hidden;
    body.hidden = wasExpanded;
    toggle.textContent = wasExpanded ? "Expand" : "Collapse";
    toggle.setAttribute("aria-expanded", String(!wasExpanded));
  });
});
