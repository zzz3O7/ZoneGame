import { timingSafeEqual } from "crypto";

// Deliberately its own thing, not a player role: the admin tool isn't a
// player-facing feature and shouldn't share any code path with
// cookies.js/sessionStore.js. A single shared-secret token is enough for
// a personal admin tool — swap for something stronger before handing
// access to anyone else.
//
// Read fresh from process.env on every call (not cached at import time)
// so setting it via the process manager / .env and restarting is enough
// — no separate "reload config" step to remember.
export function isAdminConfigured() {
  return Boolean(process.env.ADMIN_TOKEN);
}

function extractToken(req) {
  const header = req.headers["authorization"];
  if (header?.startsWith("Bearer ")) return header.slice("Bearer ".length).trim();
  // Fallback header, since some tools (curl one-liners, browser fetch
  // during quick debugging) are more convenient without a full Bearer
  // header — accepted alongside Authorization, not instead of it.
  const custom = req.headers["x-admin-token"];
  return typeof custom === "string" ? custom.trim() : null;
}

export function isAuthorizedAdmin(req) {
  const token = process.env.ADMIN_TOKEN;
  if (!token) return false;
  const provided = extractToken(req);
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
