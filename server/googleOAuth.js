import { authConfig } from "./config.js";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const USERINFO_ENDPOINT = "https://www.googleapis.com/oauth2/v3/userinfo";

export function buildGoogleAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: authConfig.googleClientId,
    redirect_uri: authConfig.googleRedirectUri,
    response_type: "code",
    scope: "openid email profile",
    state,
    prompt: "select_account",
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

// Exchanges a one-time auth code for the player's verified Google
// identity. Two server-to-server calls: code -> access token, then
// access token -> profile. Neither ever touches the browser.
export async function exchangeCodeForUserInfo(code) {
  const tokenRes = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: authConfig.googleClientId,
      client_secret: authConfig.googleClientSecret,
      redirect_uri: authConfig.googleRedirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) {
    throw new Error(`Google token exchange failed: ${tokenRes.status}`);
  }
  const { access_token } = await tokenRes.json();

  const userRes = await fetch(USERINFO_ENDPOINT, {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  if (!userRes.ok) {
    throw new Error(`Google userinfo fetch failed: ${userRes.status}`);
  }
  const userInfo = await userRes.json();
  return { googleSub: userInfo.sub, email: userInfo.email };
}
