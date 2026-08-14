// Talks to server/authRoutes.js. Deliberately plain fetch, not WS
// messages — login itself is a real browser redirect through Google,
// not something a WebSocket round-trip can do.

export async function fetchAccount() {
  const res = await fetch("/auth/me");
  return res.json(); // { loggedIn, email?, nickname?, rating? }
}

export function signInWithGoogle() {
  location.href = "/auth/google/start";
}

export async function signOut() {
  await fetch("/auth/logout", { method: "POST" });
}

// Resolves { nickname } on success, throws Error(message) on failure —
// the caller (nickname modal) shows err.message inline next to the field.
export async function claimNickname(nickname) {
  const res = await fetch("/auth/nickname", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nickname }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Could not set nickname");
  return data;
}
