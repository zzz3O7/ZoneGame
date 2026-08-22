import { createHmac, timingSafeEqual } from "crypto";
import { authConfig } from "./config.js";

const COOKIE_NAME = "zonegame_session";
// Exported so sessionStore.js can expire its persisted rows at the same
// horizon the cookie itself expires at, instead of duplicating this
// number and risking the two drifting apart.
export const MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

// The cookie only ever holds an opaque session id — signing it just
// means a tampered/forged cookie is rejected without a session-store
// lookup, not that the cookie carries any sensitive payload itself.
function sign(value) {
  const mac = createHmac("sha256", authConfig.cookieSecret).update(value).digest("base64url");
  return `${value}.${mac}`;
}

function unsign(signed) {
  const dot = signed.lastIndexOf(".");
  if (dot === -1) return null;
  const value = signed.slice(0, dot);
  const expected = sign(value);
  const a = Buffer.from(signed);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return value;
}

export function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

// Returns the verified session id, or null if absent/tampered.
export function readSessionCookie(req) {
  const raw = parseCookies(req)[COOKIE_NAME];
  if (!raw) return null;
  return unsign(raw);
}

export function buildSessionCookie(sessionId, { clear = false } = {}) {
  const value = clear ? "" : sign(sessionId);
  const maxAge = clear ? 0 : MAX_AGE_SECONDS;
  return [
    `${COOKIE_NAME}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ].join("; ");
}
