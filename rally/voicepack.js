/*
 * Co-driver audio: the in-car intercom sound and recorded voice packs.
 *
 * Intercom — a helmet-mic radio effect built with Web Audio: band-limited,
 * slightly overdriven and compressed voice with a static "squelch" click when
 * the co-driver keys the mic and when they let go.
 *
 * VoicePack — recorded clips, one per word ("3", "left", "100", "tightens"…),
 * stitched together into calls the way rally games do it. voice/manifest.json
 * lists them either as local files (voice/<word>.<format>):
 *   { "format": "mp3", "clips": ["1", "2", "left", "right", "100", …] }
 * or as URLs relative to "base":
 *   { "base": "https://…/", "clips": { "left": "left-take2.wav", … } }
 * Calls that use a word the pack doesn't have fall back to the phone's voice.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CoDriverAudio = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const WORD_NUMBERS = { one: '1', two: '2', three: '3', four: '4', five: '5', six: '6' };

  // Two-word callouts recorded as one clip.
  const COMPOUNDS = [['stop sign', 'stop-sign'], ['speed camera', 'speed-camera'], ['rail crossing', 'rail-crossing']];

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
    let joined = norm;
    for (const [words, token] of COMPOUNDS) joined = joined.split(words).join(token);
    const out = [];
    for (const part of joined.split(/(,)/)) {
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

  // Helmet-mic intercom: band-limited, a little overdriven, heavily compressed.
  // Returns the node to connect voice sources to. Works on live and offline contexts.
  function radioChain(c, destination) {
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
    hp.connect(lp).connect(presence).connect(drive).connect(comp).connect(out).connect(destination);
    return hp;
  }

  function noiseBuffer(c, seconds) {
    const buf = c.createBuffer(1, Math.round(c.sampleRate * seconds), c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  // Press-to-talk click + burst of static. Returns its length in seconds.
  function squelchOn(c, destination, noise, at, open) {
    const len = open ? 0.07 : 0.12;
    const src = c.createBufferSource();
    src.buffer = noise;
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = open ? 2600 : 1700;
    bp.Q.value = 0.8;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(open ? 0.32 : 0.2, at + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, at + len);
    src.connect(bp).connect(g).connect(destination);
    src.start(at, Math.random() * 0.5);
    src.stop(at + len + 0.02);
    return len;
  }

  // Low static under the voice while the mic is open.
  function hissOn(c, destination, noise, from, to) {
    if (to <= from) return;
    const src = c.createBufferSource();
    src.buffer = noise;
    src.loop = true;
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2200;
    bp.Q.value = 0.5;
    const g = c.createGain();
    g.gain.setValueAtTime(0.018, from);
    src.connect(bp).connect(g).connect(destination);
    src.start(from);
    src.stop(to);
  }

  // AudioBuffer → 16-bit PCM WAV Blob (first `seconds` only, if given).
  function encodeWav(buf, seconds) {
    const sr = buf.sampleRate;
    const data = buf.getChannelData(0);
    const n = Math.min(data.length, seconds ? Math.ceil(seconds * sr) : data.length);
    const out = new DataView(new ArrayBuffer(44 + n * 2));
    const text = (o, str) => { for (let i = 0; i < str.length; i++) out.setUint8(o + i, str.charCodeAt(i)); };
    text(0, 'RIFF');
    out.setUint32(4, 36 + n * 2, true);
    text(8, 'WAVE');
    text(12, 'fmt ');
    out.setUint32(16, 16, true);
    out.setUint16(20, 1, true);
    out.setUint16(22, 1, true);
    out.setUint32(24, sr, true);
    out.setUint32(28, sr * 2, true);
    out.setUint16(32, 2, true);
    out.setUint16(34, 16, true);
    text(36, 'data');
    out.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) out.setInt16(44 + i * 2, Math.max(-1, Math.min(1, data[i])) * 0x7fff, true);
    return new Blob([out.buffer], { type: 'audio/wav' });
  }

  // A short silent WAV, played inside a tap to unlock the <audio> element on phones.
  function silentWavUrl() {
    const sr = 8000;
    const n = 400;
    const out = new DataView(new ArrayBuffer(44 + n * 2));
    const text = (o, str) => { for (let i = 0; i < str.length; i++) out.setUint8(o + i, str.charCodeAt(i)); };
    text(0, 'RIFF'); out.setUint32(4, 36 + n * 2, true); text(8, 'WAVE'); text(12, 'fmt ');
    out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
    out.setUint32(24, sr, true); out.setUint32(28, sr * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true);
    text(36, 'data'); out.setUint32(40, n * 2, true);
    return URL.createObjectURL(new Blob([out.buffer], { type: 'audio/wav' }));
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
        this.radio = radioChain(this.ctx, this.ctx.destination);
        this.clean = this.ctx.createGain();
        this.clean.connect(this.ctx.destination);
        this.noise = noiseBuffer(this.ctx, 1.5);
      }
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      return this.ctx;
    }

    now() {
      return this.ctx ? this.ctx.currentTime : 0;
    }

    squelch(at, open) {
      return this.ctx ? squelchOn(this.ctx, this.ctx.destination, this.noise, at, open) : 0;
    }

    hiss(from, to) {
      if (this.ctx) hissOn(this.ctx, this.ctx.destination, this.noise, from, to);
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
      this.urls = {};       // word → clip URL, from the manifest
      this.buffers = {};    // word → decoded, trimmed AudioBuffer
      this.loaded = false;  // manifest read
      this.ready = false;   // at least one clip decoded
    }

    // Reads the manifest and decodes the clips. Decoding needs the clip host
    // to allow cross-origin reads; when it doesn't, clips can still be streamed.
    async load(ctx) {
      try {
        const res = await fetch(`${this.base}manifest.json`, { cache: 'no-cache' });
        if (!res.ok) return false;
        const manifest = await res.json();
        const clips = manifest.clips || [];
        const entries = Array.isArray(clips)
          ? clips.map(name => [name, `${this.base}${encodeURIComponent(name)}.${manifest.format || 'mp3'}`])
          : Object.keys(clips).map(name => [name, (manifest.base || this.base) + clips[name]]);
        entries.forEach(([name, url]) => { this.urls[name] = url; });
        this.loaded = entries.length > 0;
        await Promise.all(entries.map(async ([name, url]) => {
          try {
            const r = await fetch(url);
            if (!r.ok) return;
            this.buffers[name] = trimSilence(ctx, await decode(ctx, await r.arrayBuffer()));
          } catch (e) { /* not decodable here; streaming still works */ }
        }));
      } catch (e) {
        return false;
      }
      this.ready = Object.keys(this.buffers).length > 0;
      return this.loaded;
    }

    // Every word of the call has a decoded clip.
    canSay(text) {
      const tokens = tokenize(text);
      return this.ready && tokens.length > 0 && tokens.every(t => t === ',' || this.buffers[t]);
    }

    // Every word has a clip URL (for streaming when decoding isn't possible).
    canStream(text) {
      const tokens = tokenize(text);
      return this.loaded && tokens.length > 0 && tokens.every(t => t === ',' || this.urls[t]);
    }

    streamUrls(text) {
      return tokenize(text).filter(t => t !== ',').map(t => this.urls[t]);
    }

    // Lay the call out on context `c` from time `at`; returns {end, sources}.
    schedule(c, voiceIn, noise, text, radio, at) {
      const sources = [];
      if (radio) at += squelchOn(c, c.destination, noise, at, true) + 0.015;
      const voiceStart = at;
      for (const tok of tokenize(text)) {
        if (tok === ',') {
          at += 0.11;
          continue;
        }
        const buf = this.buffers[tok];
        const src = c.createBufferSource();
        src.buffer = buf;
        src.connect(voiceIn);
        src.start(at);
        sources.push(src);
        at += Math.max(0.05, buf.duration - 0.025);
      }
      if (radio) {
        hissOn(c, c.destination, noise, voiceStart, at + 0.03);
        at += 0.04;
        at += squelchOn(c, c.destination, noise, at, false);
      }
      return { end: at, sources };
    }

    // Play live through Web Audio. Returns {duration (s), stop()}.
    play(intercom, text, radio) {
      const c = intercom.ctx;
      const start = c.currentTime + 0.03;
      const { end, sources } = this.schedule(c, radio ? intercom.radio : intercom.clean, intercom.noise, text, radio, start);
      return {
        duration: end - c.currentTime,
        stop: () => sources.forEach(src => { try { src.stop(); } catch (e) { /* already ended */ } }),
      };
    }

    // Render the call (with the intercom effect) to a WAV blob URL, for playing
    // through an <audio> element. Resolves {url, duration}.
    async render(text, radio) {
      const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      const sr = 24000;
      let estimate = 0.6;
      for (const t of tokenize(text)) estimate += t === ',' ? 0.11 : this.buffers[t].duration;
      const c = new OAC(1, Math.ceil(estimate * sr), sr);
      const voiceIn = radio ? radioChain(c, c.destination) : c.destination;
      const { end } = this.schedule(c, voiceIn, noiseBuffer(c, 1.5), text, radio, 0.01);
      const rendered = await new Promise((resolve, reject) => {
        c.oncomplete = e => resolve(e.renderedBuffer);
        const p = c.startRendering();
        if (p && p.then) p.then(resolve, reject);
      });
      return { url: URL.createObjectURL(encodeWav(rendered, end + 0.02)), duration: end };
    }
  }

  return { tokenize, Intercom, VoicePack, PHRASES, COMPOUNDS, silentWavUrl };
});
