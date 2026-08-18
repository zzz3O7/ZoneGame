// OAuth + session config, read from environment variables so secrets
// never live in the repo. Validated lazily (only auth routes check
// isAuthConfigured()) so the game itself still boots without them.

export const authConfig = {
  googleClientId: process.env.GOOGLE_CLIENT_ID,
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
  // e.g. https://zonegame.randover.site/auth/google/callback
  googleRedirectUri: process.env.GOOGLE_REDIRECT_URI,
  // random long string, used to sign session cookies
  cookieSecret: process.env.COOKIE_SECRET,
  // where to send the browser after a successful login
  frontendUrl: process.env.FRONTEND_URL || "/",
};

export function isAuthConfigured() {
  return Boolean(
    authConfig.googleClientId &&
    authConfig.googleClientSecret &&
    authConfig.googleRedirectUri &&
    authConfig.cookieSecret,
  );
}
