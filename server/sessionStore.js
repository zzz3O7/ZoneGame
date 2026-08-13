import { randomUUID } from "crypto";

// STEP 1 SCAFFOLDING ONLY. Nothing here survives a restart — step 2
// swaps both maps for SQLite-backed tables (`players`, plus a real
// sessions table or this same in-memory map kept as a cache in front
// of it). Kept deliberately minimal so the OAuth round-trip itself can
// be verified before persistence enters the picture.

const playersByGoogleSub = new Map(); // googleSub -> player
const sessions = new Map(); // sessionId -> googleSub

export function findOrCreatePlayer({ googleSub, email }) {
  let player = playersByGoogleSub.get(googleSub);
  if (!player) {
    player = { googleSub, email, nickname: null, rating: 1000, createdAt: Date.now() };
    playersByGoogleSub.set(googleSub, player);
  }
  return player;
}

export function getPlayerByGoogleSub(googleSub) {
  return playersByGoogleSub.get(googleSub) || null;
}

export function createSession(googleSub) {
  const sessionId = randomUUID();
  sessions.set(sessionId, googleSub);
  return sessionId;
}

export function getSessionPlayer(sessionId) {
  const googleSub = sessions.get(sessionId);
  if (!googleSub) return null;
  return getPlayerByGoogleSub(googleSub);
}

export function destroySession(sessionId) {
  sessions.delete(sessionId);
}
