'use strict';
/* ============================================================================
   Audio — background music loop + a tiny WebAudio "chiptune" synth for SFX.
   No sample libraries: every effect below is a couple of oscillators and
   noise bursts shaped with short gain envelopes, in the spirit of 16-bit
   console sound chips. Two independent toggles (music / sound), both
   persisted, both default-safe for autoplay policy (nothing plays until a
   user gesture — the splash buttons or any topbar toggle — unlocks audio).
   ============================================================================ */

const SFX = (() => {
  let ctx = null;
  let sfxOn = true;

  function unlock() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function setEnabled(v) { sfxOn = v; }

  function envGain(peak, t0, attack, hold, decay) {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + attack);
    g.gain.setValueAtTime(peak, t0 + attack + hold);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + hold + decay);
    return g;
  }

  function tone(freq, t0, dur, type, peak, glideTo) {
    const osc = ctx.createOscillator();
    osc.type = type || 'square';
    osc.frequency.setValueAtTime(freq, t0);
    if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, t0 + dur);
    const g = envGain(peak != null ? peak : 0.18, t0, Math.min(0.012, dur * 0.2), dur * 0.4, dur * 0.6);
    osc.connect(g).connect(ctx.destination);
    osc.start(t0); osc.stop(t0 + dur + 0.05);
  }

  function noiseBurst(t0, dur, filterFreq, peak, filterType) {
    const n = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const filt = ctx.createBiquadFilter();
    filt.type = filterType || 'lowpass';
    filt.frequency.setValueAtTime(filterFreq, t0);
    const g = envGain(peak != null ? peak : 0.22, t0, 0.008, dur * 0.25, dur * 0.75);
    src.connect(filt).connect(g).connect(ctx.destination);
    src.start(t0); src.stop(t0 + dur + 0.05);
  }

  const CUES = {
    click() {
      tone(720, ctx.currentTime, 0.05, 'square', 0.10);
    },
    tab() {
      tone(540, ctx.currentTime, 0.045, 'triangle', 0.08);
    },
    purge() {
      const t = ctx.currentTime;
      noiseBurst(t, 0.5, 320, 0.14, 'bandpass');
      tone(70, t, 0.5, 'sawtooth', 0.08);
    },
    ignite() {
      const t = ctx.currentTime;
      noiseBurst(t, 0.16, 900, 0.16, 'highpass');
      tone(180, t + 0.05, 0.35, 'sawtooth', 0.16, 640);
    },
    spoolup() {
      const t = ctx.currentTime;
      tone(140, t, 0.9, 'sawtooth', 0.12, 780);
      tone(140 * 1.5, t, 0.9, 'square', 0.05, 780 * 1.5);
    },
    sync() {
      const t = ctx.currentTime;
      tone(110, t, 0.09, 'square', 0.20);
      tone(660, t + 0.09, 0.09, 'square', 0.14);
      tone(880, t + 0.18, 0.12, 'square', 0.14);
    },
    warning() {
      const t = ctx.currentTime;
      tone(740, t, 0.11, 'square', 0.15);
      tone(740, t + 0.16, 0.11, 'square', 0.15);
    },
    serious() {
      const t = ctx.currentTime;
      tone(600, t, 0.09, 'square', 0.16);
      tone(600, t + 0.13, 0.09, 'square', 0.16);
      tone(600, t + 0.26, 0.09, 'square', 0.16);
    },
    trip() {
      const t = ctx.currentTime;
      tone(500, t, 0.4, 'sawtooth', 0.18, 90);
      noiseBurst(t, 0.25, 500, 0.10, 'lowpass');
    },
    wreck() {
      const t = ctx.currentTime;
      noiseBurst(t, 0.9, 900, 0.30, 'lowpass');
      tone(60, t, 0.8, 'square', 0.22, 30);
      tone(45, t + 0.05, 0.8, 'sawtooth', 0.16, 25);
    },
    good() {
      const t = ctx.currentTime;
      tone(523, t, 0.09, 'square', 0.14);
      tone(659, t + 0.09, 0.09, 'square', 0.14);
      tone(784, t + 0.18, 0.14, 'square', 0.16);
    },
    cash() {
      const t = ctx.currentTime;
      tone(880, t, 0.06, 'square', 0.12);
      tone(1180, t + 0.06, 0.09, 'square', 0.12);
    },
  };

  function play(name) {
    if (!sfxOn) return;
    const c = unlock();
    if (!c) return;
    const cue = CUES[name];
    if (cue) { try { cue(); } catch (e) { /* audio is best-effort */ } }
  }

  return { play, setEnabled, unlock };
})();

const Music = (() => {
  let el = null;
  let on = false;

  function init(audioEl) {
    el = audioEl;
    el.volume = 0.35;
  }

  function setEnabled(v) {
    on = v;
    if (!el) return;
    if (on) { SFX.unlock(); el.play().catch(() => {}); }
    else el.pause();
  }

  function isOn() { return on; }

  return { init, setEnabled, isOn };
})();

window.SFX = SFX;
window.Music = Music;
