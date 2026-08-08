import { Game } from "./game.js";
import { Renderer } from "./renderer.js";
import { GameUI } from "./gameUI.js";
import { initHintsPanel } from "./hintsPanel.js";
import { Connection } from "./net/connection.js";
import { MatchClient } from "./net/matchClient.js";
import { Menu } from "./menu.js";
import { showBanner, hideBanner } from "./banner.js"; // ADDED
import { DISCONNECT_ABORT_MS } from "./config.js"; // ADDED

const menuScreen = document.getElementById("menuScreen");
const waitingRoomScreen = document.getElementById("waitingRoomScreen");
const gameScreen = document.getElementById("gameScreen");

let ui = null;
let lastLocalParams = null; // set only for local hotseat games; drives rematch/same-board
let currentConnection = null; // so leaving (back to menu / cancel) can actually close the socket
let currentMatchClient = null; // ADDED: so leaveCurrentMatch can send LEAVE_MATCH even before any GameUI exists (e.g. cancelling the waiting room)
let opponentDisconnectTimer = null; // drives the live countdown text in the opponent-disconnected banner
let bannerAutoHideTimer = null; // FIXED: was a bare setTimeout in handleOpponentReconnected — could fire late and clobber a newer, more urgent banner it knows nothing about
let reconnectInProgress = false; // FIXED: guards handleConnectionLost against running twice at once (e.g. a move attempted mid-reconnect can independently trigger onConnectionLost again)

function showScreen(screen) {
  [menuScreen, waitingRoomScreen, gameScreen].forEach((s) => (s.hidden = s !== screen));
}

function wsUrl() {
  return `wss://${location.host}/ws`;
}

// ADDED: shared teardown for "this match is done, one way or another" —
// used both when we deliberately leave (leaveCurrentMatch, below) and when
// the server/reconnect flow tells us the match is already gone and there's
// nothing left to notify.
function resetMatchState() {
  currentConnection = null;
  currentMatchClient = null;
  clearInterval(opponentDisconnectTimer);
  opponentDisconnectTimer = null;
  clearTimeout(bannerAutoHideTimer); // FIXED
  hideBanner();
}

// Leaving on purpose (back to menu, cancel waiting room, giving up on a
// reconnect) — tells the server we're actually leaving (a mid-game leave
// counts as a resign — see Match.leave), then tears everything down and
// forgets the stored session so a later page load doesn't try to resurrect
// a match we deliberately walked away from.
function leaveCurrentMatch() {
  currentMatchClient?.leaveMatch();
  currentConnection?.close();
  resetMatchState();
  MatchClient.clearSession();
}

function setupMatchClient(conn) {
  const matchClient = new MatchClient(conn);
  currentMatchClient = matchClient; // ADDED
  matchClient.onMatchStart = (game) => startGame(game, matchClient);
  matchClient.onMoveApplied = () => ui?.refresh(); // ui set once startGame runs

  // ADDED: disconnect / reconnect / end-of-match wiring
  matchClient.onOpponentDisconnected = (playerIndex, abortInMs) => handleOpponentDisconnected(abortInMs);
  matchClient.onOpponentReconnected = () => handleOpponentReconnected();
  matchClient.onMatchEnded = (info) => handleMatchEnded(info);
  matchClient.onOpponentLeft = () => handleOpponentLeft();
  matchClient.onConnectionLost = () => handleConnectionLost(matchClient);
  matchClient.onReconnectFailed = () => handleReconnectFailed();
  matchClient.onOpponentWantsRematch = () => ui?.showOpponentWantsRematch(); // ADDED
  matchClient.onRematchCancelled = () => ui?.resetRematchPrompt(); // ADDED — timed out; let them try again if they want
  // Shared by reconnect success AND hash-mismatch resync (see matchClient.js) —
  // either way, the correct move is just "rebuild the UI from what the
  // server says is true right now", same as a fresh match start.
  matchClient.onSynced = (game, syncMsg) => {
    reconnectInProgress = false; // FIXED: resolved — a later drop should be able to start a fresh retry loop
    hideBanner();
    clearInterval(opponentDisconnectTimer);
    clearTimeout(bannerAutoHideTimer); // FIXED
    routeSyncedState(matchClient, game, syncMsg);
  };

  return matchClient;
}

// where a SYNC_STATE payload sends us, based on what the match is
// currently doing. "active" and "over" both just go through startGame() —
// GameUI already renders the live board vs the endcard purely from
// game.gameOver, so reconnecting into a finished match needs no special case
// for the natural "no-moves" ending: the actions log already ends on the
// exact move that set game.gameOver, so replaying it reproduces that
// correctly on its own.
function routeSyncedState(matchClient, game, syncMsg) {
  if (syncMsg.status === "waiting") {
    populateWaitingRoom(matchClient.params ?? {}, matchClient.inviteCode);
    showScreen(waitingRoomScreen);
    return;
  }
  startGame(game, matchClient);

  // FIXED: a resign (or, defensively, an abort-forfeit) doesn't correspond
  // to any action in the replay log — there's no move to replay that would
  // ever set game.gameOver — so without this, reconnecting into a resigned
  // match silently never showed the endcard at all. Force the same override
  // a live resign already uses.
  if (syncMsg.endInfo && syncMsg.endInfo.reason !== "no-moves") {
    ui?.showForcedEnd(syncMsg.endInfo);
  }
}

// ADDED: the other player's connection dropped. Just informational — the
// server is the one keeping score, we're only reflecting its abortInMs
// countdown. Wording differs if the game had already concluded (sitting on
// the endcard already): nothing about the result is at risk at that point.
function handleOpponentDisconnected(abortInMs) {
  clearInterval(opponentDisconnectTimer);
  clearTimeout(bannerAutoHideTimer); // FIXED: don't let a stale "opponent reconnected" auto-hide clobber this
  const deadline = Date.now() + abortInMs;
  const gameAlreadyOver = ui?.game?.gameOver === true;

  const tick = () => {
    const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    const text = gameAlreadyOver
      ? `Opponent disconnected — may not return for a rematch (${remaining}s)`
      : `Opponent disconnected — waiting ${remaining}s…`;
    showBanner(text, { kind: "warning" });
    if (remaining <= 0) clearInterval(opponentDisconnectTimer);
  };
  tick();
  opponentDisconnectTimer = setInterval(tick, 500);
}

// ADDED
function handleOpponentReconnected() {
  clearInterval(opponentDisconnectTimer);
  clearTimeout(bannerAutoHideTimer); // FIXED
  showBanner("Opponent reconnected", { kind: "info" });
  bannerAutoHideTimer = setTimeout(hideBanner, 2000); // FIXED: tracked so a later banner can cancel it instead of being clobbered
}

// ADDED: genuine forfeit-by-abandonment, mid-game. The endcard needs the
// forfeit winner from the server, not the score-based one GameUI normally
// reads — see showForcedEnd in gameUI.js for why those have to stay separate.
function handleMatchEnded(info) {
  clearInterval(opponentDisconnectTimer);
  clearTimeout(bannerAutoHideTimer); // FIXED
  hideBanner();
  ui?.showForcedEnd(info);
}

// ADDED: match had already ended normally; the opponent just isn't coming
// back. The result already stands — nothing to change, just let them know.
function handleOpponentLeft() {
  clearInterval(opponentDisconnectTimer);
  clearTimeout(bannerAutoHideTimer); // FIXED
  showBanner("Opponent left the match.", { kind: "info" });
  ui?.resetRematchPrompt(); // in case we were the one waiting on a rematch they were never going to accept
}

// ADDED: our OWN connection dropped unexpectedly. Auto-retry opening a fresh
// socket (the old one is dead) for up to roughly the server's own abort
// window, minus a safety margin — once a fresh socket is up, a single
// RECONNECT_ATTEMPT is enough; the server answers with syncState or
// reconnectFailed almost immediately, so there's no need to loop past that
// point. An "Abandon" option is available from the very first message, not
// just after everything fails — no reason to make someone wait on a spinner
// they already want to leave.
async function handleConnectionLost(matchClient) {
  if (reconnectInProgress) return; // FIXED: don't start a second overlapping retry loop (e.g. a move attempted mid-reconnect can independently re-fire onConnectionLost)
  reconnectInProgress = true;

  const deadline = Date.now() + Math.max(DISCONNECT_ABORT_MS - 1500, 2000);

  const abandon = () => {
    reconnectInProgress = false; // FIXED
    leaveCurrentMatch();
    ui?.destroy();
    ui = null;
    showScreen(menuScreen);
  };

  const attempt = async () => {
    if (Date.now() >= deadline) {
      reconnectInProgress = false; // FIXED
      resetMatchState(); // was only clearing currentConnection, leaving currentMatchClient dangling
      showBanner("Couldn't reconnect — the match may be gone.", {
        kind: "danger",
        actions: [
          {
            label: "Back to menu",
            style: "primary",
            onClick: () => {
              hideBanner();
              ui?.destroy();
              ui = null;
              showScreen(menuScreen);
            },
          },
        ],
      });
      return;
    }

    const remainingS = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    showBanner(`Connection lost — reconnecting… (up to ${remainingS}s)`, {
      kind: "danger",
      actions: [{ label: "Abandon", onClick: abandon }],
    });

    try {
      const conn = new Connection(wsUrl());
      currentConnection = conn;
      await conn.connect();
      matchClient.rebindConnection(conn);
      matchClient.attemptReconnect();
      // Outcome arrives via onSynced / onReconnectFailed (set once in
      // setupMatchClient, which also clears reconnectInProgress) — nothing
      // further to do from this loop.
    } catch {
      setTimeout(attempt, 1200);
    }
  };

  attempt();
}

// ADDED: shared terminal outcome for a reconnect attempt that the server
// explicitly rejected (session invalid, or the match is genuinely gone).
function handleReconnectFailed() {
  reconnectInProgress = false; // FIXED
  resetMatchState();
  showBanner("Couldn't reconnect — that match is gone.", {
    kind: "danger",
    actions: [
      {
        label: "Back to menu",
        style: "primary",
        onClick: () => {
          hideBanner();
          ui?.destroy();
          ui = null;
          menuScreen.hidden = false;
          showScreen(menuScreen);
        },
      },
    ],
  });
}

function startGame(game, matchClient = null) {
  showScreen(gameScreen);

  ui?.destroy(); // tear down the previous match's listeners before reusing the same DOM

  const canvas = document.getElementById("board-canvas");
  const staticCanvas = document.getElementById("board-canvas-static");
  const renderer = new Renderer(canvas, staticCanvas, game.board, game.zoneRadius);

  ui = new GameUI(game, renderer, canvas, matchClient);
  ui.init();
  initHintsPanel();
}

// params here are always already resolved/clamped (see js/params.js) —
// Menu never hands raw form input to these callbacks.
function populateWaitingRoom(params, inviteCode) {
  document.getElementById("inviteCodeDisplay").textContent = inviteCode;
  document.getElementById("waitModeValue").textContent = params.mode === "classic" ? "Classic" : "Custom";
  document.getElementById("waitBoardValue").textContent = `${params.boardSize} x ${params.boardSize}`;
  document.getElementById("waitZoneRadiusValue").textContent = params.zoneRadius;
  document.getElementById("waitDominoValue").textContent = params.startingDominoes;
}

// ADDED: page-load reconnect. Checked once, before Menu even shows the
// default screen — a stored session means this tab was mid-match when it
// went away (refresh, or the tab was closed and reopened within the same
// session). Skips the menu entirely rather than making the person choose
// first; "Abandon" is right there from the first frame if they'd rather not.
function attemptPageLoadReconnect(storedSession) {
  menuScreen.hidden = true;

  const conn = new Connection(wsUrl());
  currentConnection = conn;

  const abandon = () => {
    leaveCurrentMatch();
    menuScreen.hidden = false;
  };

  showBanner("Reconnecting to your match…", {
    kind: "warning",
    actions: [{ label: "Abandon", onClick: abandon }],
  });

  conn
    .connect()
    .then(() => {
      const matchClient = setupMatchClient(conn); // sets the general-purpose matchClient.onReconnectFailed = handleReconnectFailed
      matchClient.restoreSession(storedSession);
      // FIXED: this override used to be permanent — if THIS attempt failed,
      // fine, but the same stale handler would then incorrectly run for any
      // *later*, unrelated disconnect mid-session too (e.g. one handled by
      // handleConnectionLost long after this page-load reconnect had
      // already succeeded), which only does a partial reset (never calls
      // showScreen/destroys ui) and could leave menuScreen and gameScreen
      // both visible at once. Restore the general handler immediately so
      // this override only ever applies to this one attempt.
      matchClient.onReconnectFailed = () => {
        matchClient.onReconnectFailed = () => handleReconnectFailed();
        resetMatchState();
        menuScreen.hidden = false;
      };
      // FIXED: attemptReconnect() can return false (no stored matchId/sessionId
      // to send — e.g. corrupted sessionStorage) without the server ever
      // getting a chance to reply, which would otherwise leave the
      // "Reconnecting…" banner stuck forever with no resolution.
      if (!matchClient.attemptReconnect()) {
        matchClient.onReconnectFailed = () => handleReconnectFailed();
        resetMatchState();
        menuScreen.hidden = false;
      }
    })
    .catch(() => abandon());
}

new Menu({
  onStartLocal: (params) => {
    lastLocalParams = params;
    startGame(new Game(params));
  },

  onCreateMatch: async (nickname, params) => {
    const conn = new Connection(wsUrl());
    currentConnection = conn;
    // FIXED: an unreachable server rejected this with zero user feedback —
    // the button just did nothing, forever, with only a console warning.
    try {
      await conn.connect();
    } catch {
      currentConnection = null;
      showBanner("Couldn't reach the server. Check your connection and try again.", {
        kind: "danger",
        actions: [{ label: "Dismiss", onClick: hideBanner }],
      });
      return;
    }

    const matchClient = setupMatchClient(conn);
    matchClient.onCreated = (inviteCode) => {
      populateWaitingRoom(params, inviteCode);
      showScreen(waitingRoomScreen);
    };
    matchClient.createMatch(nickname, params);
  },

  onJoinMatch: async (nickname, code) => {
    const conn = new Connection(wsUrl());
    currentConnection = conn;
    // FIXED: same as onCreateMatch above
    try {
      await conn.connect();
    } catch {
      currentConnection = null;
      showBanner("Couldn't reach the server. Check your connection and try again.", {
        kind: "danger",
        actions: [{ label: "Dismiss", onClick: hideBanner }],
      });
      return;
    }

    const matchClient = setupMatchClient(conn);
    matchClient.joinMatch(code, nickname);
  },
});

// ADDED: run the reconnect check once, at startup, before anything else.
{
  const stored = MatchClient.loadSession();
  if (stored) attemptPageLoadReconnect(stored);
}

document.getElementById("btnCopyCode").addEventListener("click", (event) => {
  const code = document.getElementById("inviteCodeDisplay").textContent;
  navigator.clipboard?.writeText(code);

  const btn = event.currentTarget;
  btn.textContent = "Copied";
  btn.classList.add("copied");
  setTimeout(() => {
    btn.textContent = "Copy";
    btn.classList.remove("copied");
  }, 1200);
});

document.getElementById("btnCancelWait").addEventListener("click", () => {
  // FIXED: actually tear down the socket (and forget the session) so the
  // server's disconnect/abort handling runs instead of leaving a ghost
  // connection open. Still just a raw close, not a clean LEAVE_MATCH.
  leaveCurrentMatch();
  showScreen(menuScreen);
});

document.getElementById("btnRematch").addEventListener("click", () => {
  if (!lastLocalParams) return; // hidden for online matches, but guard anyway
  startGame(new Game({ ...lastLocalParams, seed: undefined })); // fresh board
});

document.getElementById("btnSameBoard").addEventListener("click", () => {
  if (!lastLocalParams || !ui) return;
  startGame(new Game({ ...lastLocalParams, seed: ui.game.seed })); // same cave, roles reset
});

document.getElementById("btnBackToMenu").addEventListener("click", () => {
  // FIXED: same as cancel — close the socket and forget the session. Mid-game
  // this still just reads as an ordinary disconnect to the server (grace
  // period, then abort-forfeit) rather than an immediate forfeit — that
  // distinction goes away once resign/leave are wired through properly.
  leaveCurrentMatch();
  showScreen(menuScreen);
});
