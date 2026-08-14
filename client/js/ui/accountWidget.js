import { account, refreshAccount, onAccountChange } from "../account.js";
import { signInWithGoogle, signOut, claimNickname } from "../net/authClient.js";
import { sound } from "../audio/soundManager.js";

// Module-level (not nested in initAccountWidget) so other UI modules —
// specifically menu.js's Ranked tab — can trigger the same modal without
// this module needing to know about them.
export function promptNickname() {
  const overlay = document.getElementById("nicknameOverlay");
  const input = document.getElementById("nicknameClaimInput");
  const errorEl = document.getElementById("nicknameClaimError");
  if (!overlay) return;
  input.value = "";
  errorEl.hidden = true;
  overlay.hidden = false;
  input.focus();
}

function closeNicknameModal() {
  document.getElementById("nicknameOverlay").hidden = true;
}

// Page-level, like settingsPanel.js: one widget, reachable from every
// screen since it's fixed-position rather than scoped into menu markup.
export async function initAccountWidget() {
  const signInBtn = document.getElementById("btnSignIn");
  const profile = document.getElementById("accountProfile");
  const nameEl = document.getElementById("accountName");
  const ratingEl = document.getElementById("accountRating");
  const signOutBtn = document.getElementById("btnSignOut");

  const overlay = document.getElementById("nicknameOverlay");
  const input = document.getElementById("nicknameClaimInput");
  const errorEl = document.getElementById("nicknameClaimError");
  const confirmBtn = document.getElementById("btnNicknameConfirm");
  const skipBtn = document.getElementById("btnNicknameSkip");
  if (!signInBtn || !overlay) return;

  function render() {
    signInBtn.hidden = account.loggedIn;
    profile.hidden = !account.loggedIn;
    if (account.loggedIn) {
      nameEl.textContent = account.nickname || account.email;
      ratingEl.textContent = account.nickname ? account.rating : "";
    }
  }

  onAccountChange(() => {
    render();
    // First login (or logged in but never claimed one) — prompt once,
    // right here, rather than leaving a nameless account to discover
    // this only when they try to queue for Ranked.
    if (account.loggedIn && !account.nickname && overlay.hidden) promptNickname();
  });

  signInBtn.addEventListener("click", () => {
    sound.uiClick();
    signInWithGoogle(); // full page redirect — nothing left to do client-side after this
  });

  signOutBtn.addEventListener("click", async () => {
    sound.uiClick();
    await signOut();
    await refreshAccount();
  });

  confirmBtn.addEventListener("click", async () => {
    const value = input.value.trim();
    if (!value) {
      errorEl.textContent = "Enter a nickname.";
      errorEl.hidden = false;
      return;
    }
    try {
      await claimNickname(value);
      sound.uiConfirm();
      closeNicknameModal();
      await refreshAccount();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") confirmBtn.click();
  });
  input.addEventListener("input", () => {
    errorEl.hidden = true;
  });

  // Not tied to a persistent account requirement — guests can keep
  // playing unrated without ever setting one, they just won't see Ranked
  // light up until they do.
  skipBtn.addEventListener("click", () => {
    sound.uiClick();
    closeNicknameModal();
  });
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeNicknameModal(); // scrim click — outside the panel itself
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !overlay.hidden) closeNicknameModal();
  });

  await refreshAccount();
  render();
}
