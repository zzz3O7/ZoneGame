// All sound is synthesized via WebAudio (oscillators + noise) rather than
// loaded from audio files — no assets to ship, no build step, no license
// concerns. AudioContext is created lazily on the first play() call, since
// browsers refuse to start one before a user gesture; if that first call
// happens before any gesture, we just resume() on the next one.
//
// Exactly one SoundManager exists for the whole page (see the singleton
// export at the bottom) — audio output is a page-level resource, not a
// per-match one. GameUI used to instantiate a fresh SoundManager (and
// therefore a fresh AudioContext) on every startGame(), including every
// rematch and every reconnect/resync — old contexts were never closed, so
// a long multiplayer session (far more prone to repeated startGame() calls
// than a single hotseat game — match start, rematch, reconnect, resync all
// go through it) would eventually hit the browser's concurrent-AudioContext
// limit and every sound after that silently stopped working. A shared
// instance also means the very first user gesture anywhere on the page
// (see unlock()) keeps the same context alive for every match afterward,
// instead of each new match needing its own fresh unlock.
export class SoundManager {
  constructor() {
    this._ctx = null;
    this.uiVolume = 1; // 0..1 — interface clicks/confirm/back/discard
    this.gameVolume = 1; // 0..1 — everything else: moves, zones, game-over, multiplayer events
  }

  // category picks which of the two volume sliders (Settings) scales this
  // sound. Every public method below is "game" by default via the
  // primitives' own defaults — only the four generic UI sounds opt into
  // "ui" explicitly, so this only needed touching those four call sites
  // instead of every gain value in the file.
  _categoryVolume(category) {
    return (category === "ui" ? this.uiVolume : this.gameVolume) * 5;
  }

  _ensureCtx() {
    if (!this._ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return null; // unsupported browser — every play() below no-ops
      this._ctx = new AudioCtx();
    }
    if (this._ctx.state === "suspended") this._ctx.resume();
    return this._ctx;
  }

  // Call from a genuine, direct user-gesture handler (e.g. the very first
  // click/tap anywhere on the page) to create/resume the AudioContext while
  // it's actually allowed to. Safe to call redundantly — later sounds
  // triggered from non-gesture contexts (an incoming multiplayer move,
  // a WebSocket message) reuse this same already-unlocked context instead
  // of trying to create/resume their own, which browsers may block.
  unlock() {
    this._ensureCtx();
  }

  // One oscillator note with a short attack/decay envelope so it clicks
  // cleanly in and out instead of popping. freqTo (optional) makes it
  // sweep, for up/down "chime" character. filterFreq (optional) lowpasses
  // it to soften harsher waveforms like square/sawtooth.
  _tone({
    freq,
    freqTo = null,
    duration = 0.12,
    type = "sine",
    gain = 0.18,
    delay = 0,
    filterFreq = null,
    category = "game",
  }) {
    const ctx = this._ensureCtx();
    if (!ctx) return;
    gain *= this._categoryVolume(category);
    if (gain <= 0) return;

    const start = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    if (freqTo !== null) osc.frequency.exponentialRampToValueAtTime(Math.max(freqTo, 1), start + duration);

    amp.gain.setValueAtTime(0, start);
    amp.gain.linearRampToValueAtTime(gain, start + 0.008);
    amp.gain.exponentialRampToValueAtTime(0.0001, start + duration);

    let node = osc;
    if (filterFreq !== null) {
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = filterFreq;
      osc.connect(filter);
      node = filter;
    }

    node.connect(amp).connect(ctx.destination);
    osc.start(start);
    osc.stop(start + duration + 0.02);
  }

  // Short burst of filtered white noise. Used for the percussive click in
  // place() — bandpass with a Q gives it a resonant "knock" instead of a
  // flat hiss.
  _noiseBurst({
    duration = 0.1,
    gain = 0.15,
    filterFreq = 900,
    filterType = "lowpass",
    filterQ = 1,
    delay = 0,
    category = "game",
  }) {
    const ctx = this._ensureCtx();
    if (!ctx) return;
    gain *= this._categoryVolume(category);
    if (gain <= 0) return;

    const start = ctx.currentTime + delay;
    const frames = Math.floor(ctx.sampleRate * duration);
    const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;

    const src = ctx.createBufferSource();
    src.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.value = filterFreq;
    filter.Q.value = filterQ;

    const amp = ctx.createGain();
    amp.gain.setValueAtTime(gain, start);
    amp.gain.exponentialRampToValueAtTime(0.0001, start + duration);

    src.connect(filter).connect(amp).connect(ctx.destination);
    src.start(start);
    src.stop(start + duration + 0.02);
  }

  // The classic "wrong answer" game-show buzzer: a low tone whose amplitude
  // is rapidly chopped by a second, faster oscillator (tremolo/AM) — that
  // fast on-off pulsing is what actually reads as "buzz" rather than just
  // a harsh held note, and is what every real buzzer of this kind sounds
  // like, from doorbells to Family-Feud stings.
  _buzzer({
    freq = 150,
    lfoFreq = 45,
    duration = 0.35,
    gain = 0.16,
    filterFreq = 1000,
    carrierType = "sawtooth",
    delay = 0,
    category = "game",
  }) {
    const ctx = this._ensureCtx();
    if (!ctx) return;
    gain *= this._categoryVolume(category);
    if (gain <= 0) return;

    const start = ctx.currentTime + delay;
    const end = start + duration;

    const carrier = ctx.createOscillator();
    carrier.type = carrierType;
    carrier.frequency.setValueAtTime(freq, start);

    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = filterFreq;

    const lfo = ctx.createOscillator();
    lfo.type = "square";
    lfo.frequency.setValueAtTime(lfoFreq, start);

    // LFO output is [-1, 1]; scale/shift it into a gain-node's gain so it
    // chops the carrier's amplitude between ~0 and `gain`.
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = gain / 2;

    const amp = ctx.createGain();
    amp.gain.value = gain / 2; // base level the LFO swings around

    lfo.connect(lfoDepth).connect(amp.gain);

    // Overall envelope so it fades in/out cleanly instead of clicking at
    // the start/stop boundary.
    const envelope = ctx.createGain();
    envelope.gain.setValueAtTime(0, start);
    envelope.gain.linearRampToValueAtTime(1, start + 0.015);
    envelope.gain.setValueAtTime(1, end - 0.05);
    envelope.gain.linearRampToValueAtTime(0, end);

    carrier.connect(filter).connect(amp).connect(envelope).connect(ctx.destination);

    carrier.start(start);
    lfo.start(start);
    carrier.stop(end + 0.02);
    lfo.stop(end + 0.02);
  }

  // A piece landed on the board — a woodblock-style knock: the transient
  // click carries the sound, with only a very short, low, non-tonal thud
  // underneath — a longer/higher tone reads as hollow plastic tubing, not
  // solid wood.
  place() {
    this._noiseBurst({ duration: 0.01, gain: 0.28, filterFreq: 2130, filterType: "bandpass", filterQ: 4.5, delay: 0 });
    this._tone({ freq: 587, freqTo: 506, duration: 0.03, type: "sine", gain: 0.08, delay: 0.001, filterFreq: 3000 });
  }

  // A turn was skipped — a quick two-note downward blip, distinct from
  // place/reject so it reads clearly as "moving on" rather than an action.
  pass() {
    this._tone({ freq: 320, duration: 0.07, type: "sine", gain: 0.16, delay: 0 });
    this._tone({ freq: 230, duration: 0.09, gain: 0.14, delay: 0.07 });
  }

  // A placement/pass attempt was rejected (illegal move, not your turn).
  reject() {
    this._buzzer({
      freq: 70,
      lfoFreq: 0,
      duration: 0.1,
      gain: 0.155,
      filterFreq: 4000,
      carrierType: "sawtooth",
      delay: 0,
    });
  }

  // A zone resolved. `won` is relative to the viewer watching this screen.
  // delay lets callers stagger several zones completing on the same move.
  // lose mirrors win's two-note shape (sweep + landing note) but falls
  // instead of rises, landing an octave down — same "ta-da" rhythm, sad key.
  zoneWon(won, delay = 0) {
    if (won) {
      this._tone({ freq: 440, freqTo: 660, duration: 0.16, type: "sine", gain: 0.2, delay });
      this._tone({ freq: 660, duration: 0.14, type: "sine", gain: 0.16, delay: delay + 0.08 });
    } else {
      this._tone({ freq: 440, freqTo: 330, duration: 0.18, type: "sine", gain: 0.18, delay });
      this._tone({ freq: 220, duration: 0.22, type: "sine", gain: 0.14, delay: delay + 0.09 });
    }
  }

  // Match ended. outcome: "win" | "lose" | "draw", relative to the viewer.
  gameOver(outcome) {
    if (outcome === "win") {
      [523, 659, 784].forEach((freq, i) =>
        this._tone({ freq, duration: 0.2, type: "triangle", gain: 0.2, delay: i * 0.11 }),
      );
    } else if (outcome === "lose") {
      [392, 330, 262].forEach((freq, i) =>
        this._tone({ freq, duration: 0.22, type: "sine", gain: 0.16, delay: i * 0.12 }),
      );
    } else {
      [392, 392].forEach((freq, i) => this._tone({ freq, duration: 0.18, type: "sine", gain: 0.16, delay: i * 0.14 }));
    }
  }

  // Own clock crossed the low-time threshold — a "tick... tock" pair like
  // a mechanical clock: two short dry clicks, the second a touch lower.
  lowTime() {
    this._noiseBurst({ duration: 0.02, gain: 0.16, filterFreq: 3500, filterType: "bandpass", filterQ: 4 });
    this._tone({ freq: 2000, duration: 0.025, type: "square", gain: 0.06, filterFreq: 5000 });

    this._noiseBurst({ duration: 0.02, gain: 0.14, filterFreq: 2200, filterType: "bandpass", filterQ: 4, delay: 0.14 });
    this._tone({ freq: 1400, duration: 0.025, type: "square", gain: 0.05, filterFreq: 3500, delay: 0.14 });
  }

  // ===================== multiplayer connection/session events =====================

  // A match is actually beginning — both seats filled (or a local hotseat
  // game just started). Two-note rise, softer/shorter than gameOver's win
  // fanfare so it doesn't compete with it in character.
  matchStart() {
    this._tone({ freq: 440, duration: 0.13, type: "sine", gain: 0.16 });
    this._tone({ freq: 587, duration: 0.16, type: "sine", gain: 0.18, delay: 0.1 });
  }

  // Opponent's connection dropped. A slow wobble (low-rate tremolo) reads
  // as "connection trouble" without the harshness of reject()'s fast buzz.
  opponentDisconnected() {
    this._buzzer({ freq: 300, lfoFreq: 8, duration: 0.4, gain: 0.12, filterFreq: 1800, carrierType: "sine" });
  }

  // Opponent reconnected — mirrors opponentDisconnected's wobble with a
  // plain ascending two-note relief chime instead.
  opponentReconnected() {
    this._tone({ freq: 300, freqTo: 500, duration: 0.14, type: "sine", gain: 0.16 });
    this._tone({ freq: 500, duration: 0.12, type: "sine", gain: 0.14, delay: 0.1 });
  }

  // Match had already ended normally; opponent just isn't coming back for
  // a rematch. Purely informational — flat, no up/down direction.
  opponentLeft() {
    this._tone({ freq: 440, duration: 0.15, type: "sine", gain: 0.14 });
  }

  // Our own connection dropped unexpectedly. Needs to grab attention
  // regardless of whose turn it is, so it's a plain alert beep-beep rather
  // than anything reusing reject's "illegal move" character.
  connectionLost() {
    this._tone({ freq: 660, duration: 0.09, type: "square", gain: 0.12, filterFreq: 3000 });
    this._tone({ freq: 660, duration: 0.09, type: "square", gain: 0.12, filterFreq: 3000, delay: 0.14 });
  }

  // Reconnect attempts exhausted — the "give up" case. Lower and sadder
  // than connectionLost, shorter than gameOver's lose stinger.
  reconnectFailed() {
    this._tone({ freq: 330, freqTo: 220, duration: 0.25, type: "sine", gain: 0.16 });
    this._tone({ freq: 196, duration: 0.3, type: "sine", gain: 0.13, delay: 0.15 });
  }

  // Opponent asked for a rematch — a small inviting ping.
  rematchInvite() {
    this._tone({ freq: 700, freqTo: 900, duration: 0.1, type: "triangle", gain: 0.14, filterFreq: 5000 });
  }

  // A pending rematch fizzled (opponent left instead of accepting).
  rematchCancelled() {
    this._tone({ freq: 400, freqTo: 300, duration: 0.09, type: "sine", gain: 0.11 });
  }

  // A join/create attempt was rejected (bad invite code, match full).
  // Lighter than reject() — this is a form error, not an illegal move.
  formError() {
    this._noiseBurst({ duration: 0.1, gain: 0.14, filterFreq: 800, filterType: "lowpass", filterQ: 1, delay: 0 });
    this._noiseBurst({ duration: 0.05, gain: 0.12, filterFreq: 800, filterType: "lowpass", filterQ: 1, delay: 0.09 });
  }

  // ===================== generic UI (menus, controls) =====================

  // Neutral short click — menu tabs/cards, piece-type selection,
  // rotate/flip, calc undo/redo. Quiet enough not to fatigue under heavy
  // repeated use (e.g. mouse-wheel rotate).
  uiClick() {
    this._noiseBurst({
      duration: 0.012,
      gain: 0.12,
      filterFreq: 3200,
      filterType: "bandpass",
      filterQ: 3,
      category: "ui",
    });
  }

  // Primary action confirm — Start/Create/Join, rematch, copy code.
  // Brighter and rising vs. uiClick, without overlapping uiClick's use.
  uiConfirm() {
    this._tone({ freq: 520, freqTo: 720, duration: 0.09, type: "sine", gain: 0.14, filterFreq: 4000, category: "ui" });
  }

  // Secondary/back navigation — cancel waiting room, back to menu.
  // Descending, mirrors uiConfirm's rise.
  uiBack() {
    this._tone({ freq: 480, freqTo: 320, duration: 0.09, type: "sine", gain: 0.12, category: "ui" });
  }

  // Deliberate discard/clear — discard staged piece, calc-mode clear.
  // A soft downward whoosh, distinct from reject()'s buzzer since this is
  // an intentional cancel, not an illegal move.
  uiDiscard() {
    this._noiseBurst({
      duration: 0.08,
      gain: 0.1,
      filterFreq: 1200,
      filterType: "lowpass",
      filterQ: 0.7,
      category: "ui",
    });
    this._tone({ freq: 500, freqTo: 200, duration: 0.1, type: "sine", gain: 0.08, delay: 0.01, category: "ui" });
  }
}

// The one instance for the whole page — see the class comment above for why.
export const sound = new SoundManager();
