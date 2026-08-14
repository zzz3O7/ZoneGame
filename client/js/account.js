import { fetchAccount } from "./net/authClient.js";

// Mutable singleton, same shape whether logged in or not — consumers
// just read account.loggedIn / account.nickname / account.rating
// directly, same pattern settings.js uses for settings.
export const account = { loggedIn: false, email: null, nickname: null, rating: null };

const listeners = []; // (account) => void, called after every refresh()

export function onAccountChange(cb) {
  listeners.push(cb);
}

// Re-fetches from the server and updates the singleton in place (so
// existing references to `account` stay valid), then notifies listeners.
// Call once at boot, and again after sign-in/out or a nickname change.
export async function refreshAccount() {
  const data = await fetchAccount();
  account.loggedIn = data.loggedIn;
  account.email = data.email ?? null;
  account.nickname = data.nickname ?? null;
  account.rating = data.rating ?? null;
  listeners.forEach((cb) => cb(account));
  return account;
}

// Cheaper than refreshAccount() for the one field that actually changes
// mid-session: a rated game's result arrives over the match's own socket
// (MatchClient's RATING_UPDATE), not through a fresh fetch, so this just
// patches the singleton in place and notifies the same listeners — the
// account widget picks it up next render with no reload needed.
export function applyRatingUpdate(newRating) {
  account.rating = newRating;
  listeners.forEach((cb) => cb(account));
}
