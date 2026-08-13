import { randomUUID } from "crypto";
import { authConfig, isAuthConfigured } from "./config.js";
import { buildGoogleAuthUrl, exchangeCodeForUserInfo } from "./googleOAuth.js";
import {
  findOrCreatePlayer,
  createSession,
  getSessionPlayer,
  destroySession,
} from "./sessionStore.js";
import { readSessionCookie, buildSessionCookie } from "./cookies.js";
import { log } from "./logger.js";

// Short-lived CSRF state tokens for the OAuth redirect round-trip.
// A state is single-use and expires on its own even if never consumed,
// so an abandoned login attempt can't be replayed later.
const pendingStates = new Map();
const STATE_TTL_MS = 10 * 60 * 1000;

function issueState() {
  const state = randomUUID();
  pendingStates.set(state, Date.now());
  return state;
}

function consumeState(state) {
  const issuedAt = pendingStates.get(state);
  pendingStates.delete(state);
  return Boolean(issuedAt) && Date.now() - issuedAt < STATE_TTL_MS;
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

// Returns true if this request was an /auth/* route and was handled
// (regardless of success/failure response code) — false means the
// caller should fall through to its own 404.
export async function handleAuthRequest(req, res, url) {
  if (url.pathname === "/auth/google/start") {
    if (!isAuthConfigured()) {
      sendJson(res, 503, { error: "Google login is not configured on this server" });
      return true;
    }
    const state = issueState();
    res.writeHead(302, { Location: buildGoogleAuthUrl(state) });
    res.end();
    return true;
  }

  if (url.pathname === "/auth/google/callback") {
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state || !consumeState(state)) {
      sendJson(res, 400, { error: "Invalid or expired login attempt" });
      return true;
    }
    try {
      const { googleSub, email } = await exchangeCodeForUserInfo(code);
      findOrCreatePlayer({ googleSub, email });
      const sessionId = createSession(googleSub);
      log(`Login: ${email}`);
      res.writeHead(302, {
        Location: authConfig.frontendUrl,
        "Set-Cookie": buildSessionCookie(sessionId),
      });
      res.end();
    } catch (err) {
      console.error("OAuth callback failed:", err.message);
      sendJson(res, 502, { error: "Google login failed" });
    }
    return true;
  }

  if (url.pathname === "/auth/me") {
    const sessionId = readSessionCookie(req);
    const player = sessionId ? getSessionPlayer(sessionId) : null;
    if (!player) {
      sendJson(res, 200, { loggedIn: false });
      return true;
    }
    sendJson(res, 200, {
      loggedIn: true,
      email: player.email,
      nickname: player.nickname,
      rating: player.rating,
    });
    return true;
  }

  if (url.pathname === "/auth/logout" && req.method === "POST") {
    const sessionId = readSessionCookie(req);
    if (sessionId) destroySession(sessionId);
    res.writeHead(204, { "Set-Cookie": buildSessionCookie("", { clear: true }) });
    res.end();
    return true;
  }

  return false;
}
