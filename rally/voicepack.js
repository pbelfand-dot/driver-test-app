/*
 * Co-driver audio: the in-car intercom sound and recorded voice packs.
 *
 * Intercom — a helmet-mic radio effect built with Web Audio: band-limited,
 * slightly overdriven and compressed voice with a static "squelch" click when
 * the co-driver keys the mic and when they let go.
 *
 * VoicePack — recorded clips, one per word ("3", "left", "100", "tightens"…),
 * stitched together into calls the way rally games do it. A pack lives in
 * voice/ as <word>.<format> files plus voice/manifest.json:
 *   { "format": "mp3", "clips": ["1", "2", "left", "right", "100", …] }
 * Calls that use a word the pack doesn't have fall back to the phone's voice.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CoDriverAudio = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const WORD_NUMBERS = { one: '1', two: '2', three: '3', four: '4', five: '5', six: '6' };

  // Whole sentences recorded as a single clip.
  const PHRASES = {
    'stage complete': 'stage-complete',
    'off route recalculating': 'off-route',
    'new route notes on': 'new-route',
    'co-driver ready stage start': 'ready',
    'could not recalculate': 'reroute-failed',
  };

  // "Caution, 2 right opens, 300" → ['caution', ',', '2', 'right', 'opens', ',', '300']
  function tokenize(text) {
    const norm = String(text).toLowerCase().replace(/[.!?]/g, ' ').replace(/\s+/g, ' ').trim();
    const phrase = PHRASES[norm.replace(/,/g, '').replace(/\s+/g, ' ').trim()];
    if (phrase) return [phrase];
    const out = [];
    for (const part of norm.split(/(,)/)) {
      if (part === ',') {
        if (out.length && out[out.length - 1] !== ',') out.push(',');
        continue;
      }
      for (const w of part.trim().split(' ')) if (w) out.push(WORD_NUMBERS[w] || w);
    }
    while (out[out.length - 1] === ',') out.pop();
    return out;
  }

  function softClipCurve(drive, n = 1024) {
    const curve = new Float32Array(n);
    const norm = Math.tanh(drive);
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / (n - 1) - 1;
      curve[i] = Math.tanh(drive * x) / norm;
    }
    return curve;
  }

  class Intercom {
    constructor() {
      this.ctx = null;
    }

    get supported() {
      return typeof window !== 'undefined' && !!(window.AudioContext || window.webkitAudioContext);
    }

    // Create/resume the audio context. Call from a tap so mobile browsers allow sound.
    ensure() {
      if (!this.supported) return null;
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        this.ctx = new AC();
        this.build();
      }
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      return this.ctx;
    }

    build() {
      const c = this.ctx;
      const hp = c.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 380;
      const lp = c.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 3300;
      const presence = c.createBiquadFilter();
      presence.type = 'peaking';
      presence.frequency.value = 1900;
      presence.Q.value = 1;
      presence.gain.value = 6;
      const drive = c.createWaveShaper();
      drive.curve = softClipCurve(2.2);
      drive.oversample = '2x';
      const comp = c.createDynamicsCompressor();
      comp.threshold.value = -26;
      comp.ratio.value = 8;
      comp.attack.value = 0.003;
      comp.release.value = 0.12;
      const out = c.createGain();
      out.gain.value = 0.9;

      this.radio = c.createGain();     // voice through the intercom
      this.radio.connect(hp).connect(lp).connect(presence).connect(drive).connect(comp).connect(out).connect(c.destination);
      this.clean = c.createGain();     // voice without the effect
      this.clean.connect(c.destination);

      this.noise = c.createBuffer(1, Math.round(c.sampleRate * 1.5), c.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }

    now() {
      return this.ctx ? this.ctx.currentTime : 0;
    }

    // Press-to-talk click + burst of static. Returns its length in seconds.
    squelch(at, open) {
      const c = this.ctx;
      if (!c) return 0;
      const len = open ? 0.07 : 0.12;
      const src = c.createBufferSource();
      src.buffer = this.noise;
      const bp = c.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = open ? 2600 : 1700;
      bp.Q.value = 0.8;
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(open ? 0.32 : 0.2, at + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, at + len);
      src.connect(bp).connect(g).connect(c.destination);
      src.start(at, Math.random() * 0.5);
      src.stop(at + len + 0.02);
      return len;
    }

    // Low static under the voice while the mic is open.
    hiss(from, to) {
      const c = this.ctx;
      if (!c || to <= from) return;
      const src = c.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      const bp = c.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 2200;
      bp.Q.value = 0.5;
      const g = c.createGain();
      g.gain.setValueAtTime(0.018, from);
      src.connect(bp).connect(g).connect(c.destination);
      src.start(from);
      src.stop(to);
    }
  }

  // Cut leading/trailing silence so stitched words flow like real calls.
  function trimSilence(ctx, buf, threshold = 0.015) {
    const data = buf.getChannelData(0);
    let a = 0;
    let b = data.length - 1;
    while (a < b && Math.abs(data[a]) < threshold) a++;
    while (b > a && Math.abs(data[b]) < threshold) b--;
    const pad = Math.round(buf.sampleRate * 0.012);
    a = Math.max(0, a - pad);
    b = Math.min(data.length - 1, b + pad);
    const out = ctx.createBuffer(buf.numberOfChannels, b - a + 1, buf.sampleRate);
    for (let ch = 0; ch < buf.numberOfChannels; ch++) out.copyToChannel(buf.getChannelData(ch).subarray(a, b + 1), ch);
    return out;
  }

  function decode(ctx, bytes) {
    return new Promise((resolve, reject) => {
      const p = ctx.decodeAudioData(bytes, resolve, reject);
      if (p && p.then) p.then(resolve, reject);
    });
  }

  class VoicePack {
    constructor(baseUrl) {
      this.base = baseUrl;
      this.buffers = {};
      this.ready = false;
    }

    // Resolves true when at least one clip loaded; false when there is no pack.
    async load(ctx) {
      try {
        const res = await fetch(`${this.base}manifest.json`, { cache: 'no-cache' });
        if (!res.ok) return false;
        const manifest = await res.json();
        await Promise.all((manifest.clips || []).map(async name => {
          try {
            const r = await fetch(`${this.base}${encodeURIComponent(name)}.${manifest.format || 'mp3'}`);
            if (!r.ok) return;
            this.buffers[name] = trimSilence(ctx, await decode(ctx, await r.arrayBuffer()));
          } catch (e) { /* skip a bad clip; calls needing it use the phone voice */ }
        }));
      } catch (e) {
        return false;
      }
      this.ready = Object.keys(this.buffers).length > 0;
      return this.ready;
    }

    canSay(text) {
      const tokens = tokenize(text);
      return this.ready && tokens.length > 0 && tokens.every(t => t === ',' || this.buffers[t]);
    }

    // Schedule the call. Returns {duration (s), stop()}.
    play(intercom, text, radio) {
      const c = intercom.ctx;
      const sources = [];
      const start = c.currentTime + 0.03;
      let at = start;
      if (radio) at += intercom.squelch(at, true) + 0.015;
      const voiceStart = at;
      for (const tok of tokenize(text)) {
        if (tok === ',') {
          at += 0.11;
          continue;
        }
        const buf = this.buffers[tok];
        const src = c.createBufferSource();
        src.buffer = buf;
        src.connect(radio ? intercom.radio : intercom.clean);
        src.start(at);
        sources.push(src);
        at += Math.max(0.05, buf.duration - 0.025);
      }
      if (radio) {
        intercom.hiss(voiceStart, at + 0.03);
        at += 0.04;
        at += intercom.squelch(at, false);
      }
      return {
        duration: at - c.currentTime,
        stop: () => sources.forEach(src => { try { src.stop(); } catch (e) { /* already ended */ } }),
      };
    }
  }

  return { tokenize, Intercom, VoicePack, PHRASES };
});
