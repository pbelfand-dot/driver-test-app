/*
 * Rally Co-Driver GPS: screens, routing, the co-driver voice and the driving
 * HUD. Pace-note maths lives in pacenotes.js, free OpenStreetMap services in
 * providers.js, street maps in mapview.js and audio in voicepack.js.
 *
 * Routing: Google Maps when config.js has an API key, otherwise (or if Google
 * fails) free OpenStreetMap routing. Either way the route is checked against
 * OpenStreetMap for traffic lights, stop signs, speed cameras, rail crossings,
 * speed bumps and speed limits.
 */
(function () {
  'use strict';

  const N = window.RallyNotes;
  const P = window.MapProviders;
  const MV = window.RallyMapView;
  const G = window.Guidance;
  const $ = id => document.getElementById(id);

  const RAD = Math.PI / 180;
  const MPS_TO = { mph: 2.23694, kmh: 3.6 };
  const TIMING = { early: 7, normal: 5, late: 3.5 };   // seconds of warning before a corner
  const SIM_RATES = [1, 2, 4];
  const GRADE_COLORS = { 1: '#ff2d2d', 2: '#ff6a00', 3: '#ffa200', 4: '#ffd500', 5: '#9be15d', 6: '#3ddc84' };
  const HAZARD_COLORS = { lights: '#ff6961', stop: '#ff3b30', camera: '#bf5af2', railway: '#ffd60a', bump: '#64d2ff' };
  const HAZARD_SHORT = { lights: 'Lights', stop: 'Stop', camera: 'Camera', railway: 'Rail', bump: 'Bump' };

  const KEY = typeof GOOGLE_MAPS_API_KEY === 'string' ? GOOGLE_MAPS_API_KEY.trim() : '';
  const HAS_KEY = !!KEY && KEY !== 'YOUR_API_KEY_HERE';

  // ── Settings (per-device convenience; everything works without storage) ──

  function readStore(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch (e) {
      return fallback;
    }
  }

  function writeStore(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage blocked */ }
  }

  const settings = Object.assign({
    voiceURI: '',
    rate: 1.1,
    timing: 'normal',
    units: /^en-US\b/i.test(navigator.language || '') ? 'mph' : 'kmh',
    avoidHighways: false,
    radio: true,
    mixMusic: false,   // true: callouts mix with music, but the iPhone silent switch mutes them
    navVoice: true,    // spoken turn-by-turn directions
    rallyVoice: true,  // rally pace-note calls
  }, readStore('rally.settings', {}));

  const saveSettings = () => writeStore('rally.settings', settings);

  const intercom = new window.CoDriverAudio.Intercom();
  const voicePack = new window.CoDriverAudio.VoicePack('voice/');

  // Calls from the recorded voice pack play through one <audio> element: on an
  // iPhone that is what reaches CarPlay and plays with the silent switch on.
  const player = new Audio();
  player.setAttribute('playsinline', '');
  player.preload = 'auto';
  let playerUrl = null;

  // Last known position, to rank address suggestions nearest-first.
  let lastPos = readStore('rally.lastPos', null);
  function rememberPos(p) {
    lastPos = { lat: +p.lat.toFixed(4), lng: +p.lng.toFixed(4) };
    writeStore('rally.lastPos', lastPos);
  }

  // ── App state ──

  const state = {
    screen: 'setup',
    route: null,       // {path, steps, duration, provider, name, destinationPoint, hazards, limitWays…}
    stage: null,       // RallyNotes.buildStage(route)
    mode: null,        // 'gps' | 'sim'
    tracker: null,
    scheduler: null,
    sim: null,
    simRate: 1,
    simTimer: null,
    watchId: null,
    raf: null,
    s: 0,
    speed: 0,
    topSpeed: 0,
    lastFixAt: 0,
    accuracy: null,
    startedAt: 0,
    noteIdx: 0,
    shownNote: null,
    lastCall: '',
    finished: false,
    rerouting: false,
    lastReroute: -Infinity,
    view: 'chase',     // 'chase' (canvas) | 'map' (street map)
    endArmed: false,
    guide: [],         // turn-by-turn maneuvers (guidance.js)
    prompter: null,
    navIdx: 0,
    shownNav: null,
  };

  // ── Formatting ──

  const pad2 = n => String(n).padStart(2, '0');

  function fmtClock(sec) {
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600);
    const m = Math.floor(sec / 60) % 60;
    const s = sec % 60;
    return h ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
  }

  function fmtDuration(sec) {
    const m = Math.round(sec / 60);
    return m >= 60 ? `${Math.floor(m / 60)}h ${pad2(m % 60)}` : `${m} min`;
  }

  const distUnit = () => (settings.units === 'mph' ? 'mi' : 'km');
  const toDistUnit = m => (settings.units === 'mph' ? m / 1609.344 : m / 1000);
  const fmtDist = (m, digits = 1) => `${toDistUnit(m).toFixed(digits)} ${distUnit()}`;
  const toSpeedUnit = mps => Math.round(mps * MPS_TO[settings.units]);
  const speedUnit = () => (settings.units === 'mph' ? 'mph' : 'km/h');
  const shortPlace = label => String(label || '').split(',')[0].trim();

  function noteColor(n) {
    switch (n.kind) {
      case 'corner': return GRADE_COLORS[n.grade];
      case 'hairpin': return GRADE_COLORS[1];
      case 'square': return '#ff5a36';
      case 'finish': return '#ffffff';
      default: return HAZARD_COLORS[n.kind] || '#4fc3f7';
    }
  }

  // Compact label for pills and map markers: "4L tightens 2", "Hairpin R"…
  function shortLabel(n) {
    const d = n.dir || '';
    let t;
    switch (n.kind) {
      case 'corner':
        t = `${n.grade}${d}`;
        for (const m of n.mods) t += m === 'tightens' && n.tightTo ? ` tightens ${n.tightTo}` : ` ${m}`;
        break;
      case 'hairpin': t = `Hairpin ${d}`; break;
      case 'square': t = `Square ${d}`; break;
      case 'keep': t = `Keep ${d}`; break;
      case 'ramp': t = `Ramp ${d}`; break;
      case 'roundabout': t = n.exit ? `Roundabout ${n.exit}` : 'Roundabout'; break;
      default: t = HAZARD_SHORT[n.kind] || n.text;
    }
    if (n.at) t += ` · ${HAZARD_SHORT[n.at].toLowerCase()}`;
    return n.caution ? `⚠ ${t}` : t;
  }

  const MAP_STYLE = {
    color: noteColor,
    label: n => (n.kind === 'finish' ? '🏁' : shortLabel(n).replace('⚠ ', '')),
    priority: n => (n.kind === 'finish' ? -1 : severity(n)),
  };

  function pill(n, label = shortLabel(n)) {
    const el = document.createElement('span');
    el.className = 'pill';
    el.style.background = noteColor(n);
    el.textContent = label;
    return el;
  }

  function linkSpan(word) {
    const el = document.createElement('span');
    el.className = 'link';
    el.textContent = word;
    return el;
  }

  // ── Screens ──

  function show(name) {
    document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === `screen-${name}`));
    state.screen = name;
  }

  function setStatus(msg, isError) {
    const el = $('setup-status');
    el.textContent = msg || '';
    el.classList.toggle('error', !!isError);
  }

  // ── Co-driver voice ──

  const coDriver = {
    voices: [],
    queue: [],
    current: null,
    playing: null,
    muted: false,
    unlocked: false,
    mediaUnlocked: false,
    mediaBlocked: false,   // the browser refused <audio> playback: use the phone voice
    streamBroken: false,   // voice clips couldn't be downloaded: use the phone voice
    watchdog: null,

    get supported() {
      return 'speechSynthesis' in window;
    },

    init() {
      if (!this.supported) return;
      const load = () => {
        this.voices = speechSynthesis.getVoices();
        fillVoiceSelect();
      };
      load();
      if (speechSynthesis.addEventListener) speechSynthesis.addEventListener('voiceschanged', load);
      else speechSynthesis.onvoiceschanged = load;
    },

    // Call synchronously inside a tap: phones only allow sound that a tap started.
    unlock() {
      // iPhone (Safari 16.4+): "playback" is heard with the silent switch on but
      // pauses other audio; "ambient" mixes with music but the switch mutes it.
      const type = settings.mixMusic ? 'ambient' : 'playback';
      try {
        if (navigator.audioSession && navigator.audioSession.type !== type) navigator.audioSession.type = type;
      } catch (e) { /* not supported */ }
      intercom.ensure();
      this.mediaBlocked = false;
      this.streamBroken = false;
      if (!this.mediaUnlocked && !settings.mixMusic) {
        this.mediaUnlocked = true;
        player.src = window.CoDriverAudio.silentWavUrl();
        const p = player.play();
        if (p && p.catch) p.catch(() => { this.mediaUnlocked = false; });
      }
      if (!this.unlocked && this.supported) {
        const u = new SpeechSynthesisUtterance(' ');
        u.volume = 0;
        speechSynthesis.speak(u);
        this.unlocked = true;
      }
    },

    // Rally co-drivers are classically British, so prefer an en-GB voice.
    pickVoice() {
      const v = this.voices;
      return v.find(x => x.voiceURI === settings.voiceURI) ||
        v.find(x => /^en[-_]GB/i.test(x.lang) && x.localService) ||
        v.find(x => /^en[-_]GB/i.test(x.lang)) ||
        v.find(x => /^en\b/i.test(x.lang)) || null;
    },

    // isStale(): checked right before speaking, so calls for corners already
    // driven past are skipped instead of read late.
    say(text, isStale) {
      if (this.muted || !text) return;
      if (!this.supported && !voicePack.loaded) return;
      this.queue.push({ text, isStale });
      this.pump();
    },

    pump() {
      if (this.current) return;
      let item = this.queue.shift();
      while (item && item.isStale && item.isStale()) item = this.queue.shift();
      if (!item) return;

      const usePack = !settings.voiceURI && voicePack.loaded;
      const canStream = !this.streamBroken && voicePack.canStream(item.text);
      if (usePack && !settings.mixMusic && !this.mediaBlocked && (voicePack.canSay(item.text) || canStream)) {
        this.playMedia(item);
        return;
      }

      // Recorded voice through Web Audio: mixes with other apps' audio.
      if (usePack && settings.mixMusic && intercom.ctx && voicePack.canSay(item.text)) {
        intercom.ensure();
        const token = {};
        this.current = token;
        this.playing = voicePack.play(intercom, item.text, settings.radio);
        this.watchdog = setTimeout(() => {
          if (this.current !== token) return;
          this.current = null;
          this.playing = null;
          this.pump();
        }, this.playing.duration * 1000 + 60);
        return;
      }
      if (!this.supported) return;

      // Phone voice, framed by intercom mic clicks.
      const radio = settings.radio && intercom.ctx && intercom.ctx.state === 'running';
      const u = new SpeechSynthesisUtterance(item.text);
      const voice = this.pickVoice();
      if (voice) { u.voice = voice; u.lang = voice.lang; } else { u.lang = 'en-GB'; }
      u.rate = settings.rate;
      const done = () => {
        if (this.current !== u) return;
        clearTimeout(this.watchdog);
        this.current = null;
        if (radio) intercom.squelch(intercom.now() + 0.01, false);
        this.pump();
      };
      u.onend = done;
      u.onerror = done;
      this.current = u;
      // Some engines occasionally never fire onend; don't let that mute the stage.
      this.watchdog = setTimeout(done, 2600 + item.text.length * 110 / settings.rate);
      if (radio) {
        intercom.squelch(intercom.now() + 0.01, true);
        setTimeout(() => { if (this.current === u) speechSynthesis.speak(u); }, 90);
      } else {
        speechSynthesis.speak(u);
      }
    },

    // Recorded voice through the <audio> element: rendered with the intercom
    // effect when the clips could be decoded, otherwise streamed word by word.
    playMedia(item) {
      const token = {};
      this.current = token;
      const finish = () => {
        if (this.current !== token) return;
        clearTimeout(this.watchdog);
        player.onended = player.onerror = null;
        this.current = null;
        this.pump();
      };
      // Say this call with the phone voice instead.
      const fallBack = () => {
        if (this.current !== token) return;
        clearTimeout(this.watchdog);
        player.onended = player.onerror = null;
        this.current = null;
        this.queue.unshift(item);
        this.pump();
      };
      const playUrl = (url, onEnd, streaming) => {
        player.onended = onEnd;
        player.onerror = () => {
          // A clip that won't load (no signal, server down): stop relying on clips.
          if (streaming) this.streamBroken = true;
          else this.mediaBlocked = true;
          fallBack();
        };
        player.src = url;
        const p = player.play();
        if (p && p.catch) {
          p.catch(err => {
            if (err && err.name === 'AbortError') return;   // replaced by the next clip
            if (err && err.name === 'NotAllowedError') this.mediaBlocked = true;
            else if (streaming) this.streamBroken = true;
            else this.mediaBlocked = true;
            fallBack();
          });
        }
      };

      if (voicePack.canSay(item.text)) {
        voicePack.render(item.text, settings.radio).then(({ url, duration }) => {
          if (playerUrl) URL.revokeObjectURL(playerUrl);
          playerUrl = url;
          if (this.current !== token) return;
          if (item.isStale && item.isStale()) return finish();
          this.watchdog = setTimeout(finish, duration * 1000 + 1500);
          playUrl(url, finish, false);
        }, () => {
          this.mediaBlocked = true;
          fallBack();
        });
        return;
      }
      const urls = voicePack.streamUrls(item.text);
      let i = 0;
      const next = () => {
        if (this.current !== token) return;
        if (i >= urls.length) return finish();
        playUrl(urls[i++], next, true);
      };
      this.watchdog = setTimeout(finish, urls.length * 1500 + 2000);
      next();
    },

    stop() {
      this.queue = [];
      this.current = null;
      if (this.playing) this.playing.stop();
      this.playing = null;
      player.onended = player.onerror = null;
      if (!player.paused) player.pause();
      clearTimeout(this.watchdog);
      // Only cancel when something is queued: some Chrome builds drop a speak()
      // that follows a needless cancel().
      if (this.supported && (speechSynthesis.speaking || speechSynthesis.pending)) speechSynthesis.cancel();
    },
  };

  function fillVoiceSelect() {
    const sel = $('voice');
    const english = coDriver.voices.filter(v => /^en\b/i.test(v.lang));
    const list = english.length ? english : coDriver.voices;
    sel.innerHTML = '';
    sel.appendChild(new Option(voicePack.loaded ? 'Recorded co-driver (Higgsfield voice pack)' : 'Auto (British English if available)', ''));
    for (const v of list) sel.appendChild(new Option(`${v.name} (${v.lang})`, v.voiceURI));
    sel.value = list.some(v => v.voiceURI === settings.voiceURI) ? settings.voiceURI : '';
  }

  // ── Google routing (only with an API key) ──

  let mapsPromise = null;

  function loadMaps() {
    if (!HAS_KEY) return Promise.reject(new Error('No Google Maps API key'));
    if (!mapsPromise) {
      mapsPromise = new Promise((resolve, reject) => {
        window.__rallyMapsReady = () => resolve(window.google.maps);
        window.gm_authFailure = () => console.warn('Google rejected the API key; using OpenStreetMap instead.');
        const s = document.createElement('script');
        s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(KEY)}&v=weekly&loading=async&callback=__rallyMapsReady`;
        s.async = true;
        s.onerror = () => {
          mapsPromise = null;
          reject(new Error('Could not load Google Maps'));
        };
        document.head.appendChild(s);
      });
    }
    return mapsPromise;
  }

  // Current Maps JavaScript API routing (needs "Routes API" enabled on the key).
  async function routeWithRoutesLibrary(origin, destination) {
    const { Route } = await google.maps.importLibrary('routes');
    const { routes } = await Route.computeRoutes({
      origin,
      destination,
      travelMode: 'DRIVING',
      polylineQuality: 'HIGH_QUALITY',
      routeModifiers: { avoidHighways: settings.avoidHighways },
      fields: ['path', 'legs', 'distanceMeters', 'durationMillis', 'viewport'],
    });
    if (!routes || !routes.length) throw new Error('NO_ROUTE');
    const r = routes[0];
    const steps = [];
    for (const leg of r.legs || []) {
      for (const st of leg.steps || []) steps.push({ path: st.path, maneuver: st.maneuver, instruction: st.instructions });
    }
    return P.joinSteps(steps, r.path, r.durationMillis ? r.durationMillis / 1000 : null);
  }

  // Deprecated DirectionsService, for older keys that only have "Directions API (Legacy)".
  async function routeWithDirectionsService(origin, destination) {
    const { DirectionsService } = await google.maps.importLibrary('routes');
    const res = await new DirectionsService().route({
      origin,
      destination,
      travelMode: 'DRIVING',
      avoidHighways: settings.avoidHighways,
    });
    const r = res.routes[0];
    const steps = [];
    let duration = 0;
    for (const leg of r.legs) {
      duration += leg.duration ? leg.duration.value : 0;
      for (const st of leg.steps) steps.push({ path: st.path, maneuver: st.maneuver, instruction: st.instructions });
    }
    return P.joinSteps(steps, r.overview_path, duration || null);
  }

  async function googleRoute(origin, destination) {
    await loadMaps();
    try {
      return await routeWithRoutesLibrary(origin, destination);
    } catch (err) {
      console.warn('Routes library failed, trying the legacy DirectionsService', err);
      return routeWithDirectionsService(origin, destination);
    }
  }

  // ── Finding places and routes ──

  // A place is {lat, lng, label} (picked from suggestions or GPS) or {text}.
  async function toPoint(place, near) {
    if (place.lat !== undefined) return place;
    const found = await P.searchPlaces(place.text, near, 1);
    if (!found.length) throw new Error(`Couldn't find "${place.text}". Try adding the town or state.`);
    return found[0];
  }

  async function findRoute(from, to) {
    if (HAS_KEY) {
      try {
        const target = p => (p.lat !== undefined ? { lat: p.lat, lng: p.lng } : p.text);
        const route = await googleRoute(target(from), target(to));
        route.provider = 'google';
        return route;
      } catch (err) {
        console.warn('Google routing failed; using OpenStreetMap routing', err);
      }
    }
    const a = await toPoint(from, from.lat !== undefined ? from : lastPos);
    const b = await toPoint(to, a);
    const route = await P.routeOsrm(a, b, { avoidHighways: settings.avoidHighways });
    route.provider = 'osm';
    route.destinationPoint = { lat: b.lat, lng: b.lng };
    if (to.text && !to.label) to.label = b.label;
    return route;
  }

  function friendlyError(err) {
    const msg = String((err && err.message) || err);
    if (/^Couldn't|^Location|^This browser/.test(msg)) return msg;
    if (/NO_ROUTE|NoRoute|ZERO_RESULTS|NOT_FOUND/i.test(msg)) return "Couldn't find a driving route between those places.";
    if (/fetch|network|abort|HTTP 5|HTTP 429|Load failed/i.test(msg)) return "Couldn't reach the map servers. Check your signal and try again.";
    return `Routing failed: ${msg}`;
  }

  // Lights, signs, cameras and speed limits from OpenStreetMap along the route.
  async function addRoadFeatures(route, timeoutMs) {
    try {
      const prelim = N.buildStage(route);
      const f = await P.roadFeatures(prelim.samples, { timeoutMs });
      route.hazards = f.hazards;
      route.limitWays = f.limitWays;
      route.features = f.ok ? 'ok' : f.partial ? 'partial' : 'failed';
    } catch (e) {
      route.features = 'failed';
    }
    return route;
  }

  function currentPosition() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error('This browser has no GPS access. Type a start address instead.'));
        return;
      }
      navigator.geolocation.getCurrentPosition(
        p => {
          const here = { lat: p.coords.latitude, lng: p.coords.longitude };
          rememberPos(here);
          resolve(here);
        },
        err => reject(new Error(err.code === 1
          ? 'Location permission was denied. Allow it in Settings, or type a start address.'
          : "Couldn't get your position. Type a start address instead.")),
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 }
      );
    });
  }

  function googleMapsLink(dest) {
    const p = new URLSearchParams({ api: '1', destination: `${dest.lat},${dest.lng}`, travelmode: 'driving', dir_action: 'navigate' });
    return `https://www.google.com/maps/dir/?${p}`;
  }

  // ── Address suggestions ──

  const picked = { origin: null, destination: null };

  function attachSuggest(input, list, key) {
    let timer = null;
    let seq = 0;
    const hide = () => {
      list.classList.add('hidden');
      list.innerHTML = '';
    };
    input.addEventListener('input', () => {
      picked[key] = null;
      clearTimeout(timer);
      const q = input.value.trim();
      if (q.length < 3) {
        hide();
        return;
      }
      timer = setTimeout(async () => {
        const mine = ++seq;
        let results = [];
        try {
          results = await P.searchPlaces(q, lastPos, 5, { typing: true });
        } catch (e) { /* offline: just no suggestions */ }
        if (mine !== seq || document.activeElement !== input) return;
        list.innerHTML = '';
        for (const r of results) {
          const li = document.createElement('li');
          li.textContent = r.label;
          li.addEventListener('pointerdown', e => {
            e.preventDefault();
            input.value = r.label;
            picked[key] = r;
            if (key === 'origin') $('btn-here').classList.remove('on');
            hide();
          });
          list.appendChild(li);
        }
        list.classList.toggle('hidden', !results.length);
      }, 400);
    });
    input.addEventListener('blur', () => setTimeout(hide, 150));
    // Recent destinations when the box is empty, like any navigation app.
    if (key === 'destination') {
      input.addEventListener('focus', () => {
        if (input.value.trim().length >= 3) return;
        const recent = readStore('rally.recent', []);
        if (!recent.length) return;
        list.innerHTML = '';
        for (const r of recent) {
          const li = document.createElement('li');
          li.className = 'recent';
          li.textContent = r.label;
          li.addEventListener('pointerdown', e => {
            e.preventDefault();
            input.value = r.label;
            picked.destination = r;
            hide();
          });
          list.appendChild(li);
        }
        list.classList.remove('hidden');
      });
    }
  }

  function rememberDestination(place) {
    if (!place || place.lat === undefined || !place.label) return;
    const recent = readStore('rally.recent', []).filter(r => r.label !== place.label);
    recent.unshift({ label: place.label, lat: place.lat, lng: place.lng });
    writeStore('rally.recent', recent.slice(0, 6));
  }

  // ── Street maps ──

  // Free maps only: MapLibre + OpenFreeMap (rotates with your heading), or
  // Leaflet + OpenStreetMap tiles on phones without WebGL.
  const maps = { gl: undefined, leaflet: null, active: null };

  function mapFor(route) {
    if (!route || route.synthetic) return null;
    if (maps.gl === undefined) maps.gl = MV.glSupported() ? MV.glMap($('gmap')) : null;
    if (maps.gl) return maps.gl;
    if (!window.L) return null;
    return maps.leaflet || (maps.leaflet = MV.leafletMap($('lmap')));
  }

  async function showMapIn(slotId) {
    let m = mapFor(state.route);
    if (!m) throw new Error('No map');
    try {
      await m.ready();
    } catch (err) {
      if (m.kind !== 'gl' || !window.L) throw err;
      console.warn('Vector map unavailable; using Leaflet', err);
      maps.gl = null;
      m = mapFor(state.route);
      await m.ready();
    }
    $(slotId).appendChild(m.container);
    m.resize();
    if (maps.active !== m) {
      m.onUserMove(() => $('btn-recenter').classList.toggle('hidden', state.screen !== 'drive'));
      maps.active = m;
    }
    return m;
  }

  let lastFollow = 0;

  function updateMapCar(s, force) {
    const m = maps.active;
    if (!m || state.view !== 'map') return;
    const now = performance.now();
    const every = state.mode === 'sim' ? 500 : 1000;
    if (!force && now - lastFollow < every) return;
    lastFollow = now;
    const S = state.stage.samples;
    m.setProgress(s);
    m.follow(N.pointAt(S, s), N.headingAt(S, s, 15), state.speed, every);
  }

  // ── Canvas stage views ──

  class StageView {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.stage = null;
      this.cam = null;
    }

    setStage(stage) {
      this.stage = stage;
      this.cam = null;
      this.origin = stage.samples[0];
      this.ky = 6371008.8 * RAD;
      this.kx = this.ky * Math.cos(this.origin.lat * RAD);
      this.xy = stage.samples.map(p => this.toXY(p));
    }

    // Local flat projection in metres (x east, y north).
    toXY(p) {
      return [(p.lng - this.origin.lng) * this.kx, (p.lat - this.origin.lat) * this.ky];
    }

    fit() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = this.canvas.clientWidth;
      const h = this.canvas.clientHeight;
      if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
        this.canvas.width = Math.round(w * dpr);
        this.canvas.height = Math.round(h * dpr);
      }
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.w = w;
      this.h = h;
      return w > 0 && h > 0;
    }

    clear() {
      this.ctx.fillStyle = '#07090c';
      this.ctx.fillRect(0, 0, this.w, this.h);
    }

    line(pts, color, width, alpha = 1) {
      const c = this.ctx;
      if (pts.length < 2) return;
      c.globalAlpha = alpha;
      c.strokeStyle = color;
      c.lineWidth = width;
      c.lineCap = 'round';
      c.lineJoin = 'round';
      c.beginPath();
      c.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]);
      c.stroke();
      c.globalAlpha = 1;
    }

    label(x, y, text, bg, placed) {
      const c = this.ctx;
      c.font = '800 16px "Barlow Condensed", "Arial Narrow", sans-serif';
      const w = c.measureText(text).width + 12;
      const h = 22;
      const box = [x - w / 2, y - h / 2, w, h];
      if (placed && placed.some(b => box[0] < b[0] + b[2] && b[0] < box[0] + w && box[1] < b[1] + b[3] && b[1] < box[1] + h)) return;
      if (placed) placed.push(box);
      c.fillStyle = bg;
      c.beginPath();
      if (c.roundRect) c.roundRect(box[0], box[1], w, h, 5); else c.rect(box[0], box[1], w, h);
      c.fill();
      c.fillStyle = '#111';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(text, x, y + 1);
    }

    range(a, b, project) {
      const S = this.stage.samples;
      const out = [];
      const i0 = N.indexAt(S, a);
      const i1 = Math.min(S.length - 1, N.indexAt(S, b) + 1);
      for (let i = i0; i <= i1; i++) out.push(project(this.xy[i]));
      return out;
    }

    // Whole stage, north up — used on the briefing screen without a street map.
    drawOverview() {
      if (!this.stage || !this.fit()) return;
      this.clear();
      const pad = 28;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const [x, y] of this.xy) {
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
      const scale = Math.min((this.w - 2 * pad) / (maxX - minX || 1), (this.h - 2 * pad) / (maxY - minY || 1));
      const ox = (this.w - (maxX - minX) * scale) / 2;
      const oy = (this.h - (maxY - minY) * scale) / 2;
      const project = ([x, y]) => [ox + (x - minX) * scale, this.h - (oy + (y - minY) * scale)];

      const all = this.xy.map(project);
      this.line(all, '#1c2129', 12);
      this.line(all, '#3a424e', 6);
      const notes = this.stage.notes;
      for (const n of notes) if (n.type === 'corner') this.line(this.range(n.start, n.end, project), noteColor(n), 6);

      const start = all[0];
      const end = all[all.length - 1];
      this.ctx.fillStyle = '#3ddc84';
      this.ctx.beginPath();
      this.ctx.arc(start[0], start[1], 7, 0, Math.PI * 2);
      this.ctx.fill();

      const placed = [];
      this.label(end[0], end[1] - 16, 'FINISH', '#ffffff', placed);
      const order = notes.filter(n => n.kind !== 'finish').sort((a, b) => severity(a) - severity(b));
      for (const n of order) {
        const p = project(this.xy[N.indexAt(this.stage.samples, n.apex)]);
        this.label(p[0], p[1] - 16, MAP_STYLE.label(n), noteColor(n), placed);
      }
    }

    // Heading-up chase view around the car — the drive screen.
    drawChase(s, speed) {
      if (!this.stage || !this.fit()) return;
      this.clear();
      const S = this.stage.samples;
      const target = N.headingAt(S, s, 20);
      this.cam = this.cam === null ? target : (this.cam + N.wrap180(target - this.cam) * 0.12 + 360) % 360;
      const hd = this.cam * RAD;
      const sin = Math.sin(hd), cos = Math.cos(hd);
      const car = this.toXY(N.pointAt(S, s));

      const ahead = Math.max(160, Math.min(420, 120 + speed * 7));
      const scale = (this.h * 0.7) / ahead;
      const cx = this.w / 2;
      const cy = this.h * 0.8;
      const project = ([x, y]) => {
        const dx = x - car[0], dy = y - car[1];
        return [cx + (dx * cos - dy * sin) * scale, cy - (dx * sin + dy * cos) * scale];
      };

      const roadW = Math.max(12, Math.min(30, 8 * scale));
      const behind = this.range(s - 150, s, project);
      const front = this.range(s, s + ahead * 1.5, project);
      this.line(behind, '#1a1f26', roadW + 6);
      this.line(behind, '#262c35', roadW);
      this.line(front, '#1c2129', roadW + 6);
      this.line(front, '#3a424e', roadW);

      const placed = [];
      const visible = this.stage.notes.filter(n => n.end > s - 20 && n.start < s + ahead * 1.5);
      for (const n of visible) {
        if (n.type === 'corner') this.line(this.range(Math.max(n.start, s - 20), n.end, project), noteColor(n), roadW * 0.45);
      }
      for (const n of visible) {
        if (n.kind === 'finish') {
          const p = project(this.xy[N.indexAt(S, n.start)]);
          this.label(p[0], p[1] - roadW, '🏁 FINISH', '#ffffff', placed);
          continue;
        }
        if (n.start < s) continue;
        const p = project(this.xy[N.indexAt(S, n.start)]);
        if (n.type === 'event' && HAZARD_COLORS[n.kind]) {
          // A bar across the road where the light, sign or camera is.
          const q = project(this.xy[Math.min(S.length - 1, N.indexAt(S, n.start) + 2)]);
          const ang = Math.atan2(q[1] - p[1], q[0] - p[0]) + Math.PI / 2;
          const dx = Math.cos(ang) * (roadW * 0.7), dy = Math.sin(ang) * (roadW * 0.7);
          this.line([[p[0] - dx, p[1] - dy], [p[0] + dx, p[1] + dy]], noteColor(n), 5);
        }
        const side = n.dir === 'L' ? -1 : 1;
        this.label(p[0] + side * (roadW + 26), p[1], MAP_STYLE.label(n), noteColor(n), placed);
      }

      const c = this.ctx;
      c.save();
      c.translate(cx, cy);
      c.shadowColor = 'rgba(255, 204, 0, 0.6)';
      c.shadowBlur = 16;
      c.fillStyle = '#ffcc00';
      c.beginPath();
      c.moveTo(0, -16);
      c.lineTo(11, 12);
      c.lineTo(0, 6);
      c.lineTo(-11, 12);
      c.closePath();
      c.fill();
      c.restore();
    }
  }

  // Lower = more important; used to give slow corners and hazards label priority.
  function severity(n) {
    if (n.kind === 'hairpin') return 0;
    if (n.kind === 'camera' || n.kind === 'stop') return 0.5;
    if (n.kind === 'square') return 1;
    if (n.kind === 'corner') return n.grade;
    return 7;
  }

  // ── Note glyphs (the big icon on the HUD) ──

  const GLYPH_RADIUS = { hairpin: 10, square: 3, keep: 60, ramp: 60, 1: 12, 2: 17, 3: 24, 4: 32, 5: 44, 6: 60 };
  const FONT = 'Barlow Condensed, Arial Narrow, Arial, sans-serif';

  const HAZARD_GLYPHS = {
    lights: c => `<svg viewBox="0 0 100 100"><rect x="33" y="6" width="34" height="88" rx="11" fill="#111" stroke="${c}" stroke-width="5"/><circle cx="50" cy="27" r="10" fill="#ff3b30"/><circle cx="50" cy="50" r="10" fill="#ffcc00"/><circle cx="50" cy="73" r="10" fill="#3ddc84"/></svg>`,
    stop: () => `<svg viewBox="0 0 100 100"><polygon points="30,5 70,5 95,30 95,70 70,95 30,95 5,70 5,30" fill="#c8102e" stroke="#fff" stroke-width="4"/><text x="50" y="61" text-anchor="middle" font-size="28" font-weight="800" fill="#fff" font-family="${FONT}">STOP</text></svg>`,
    camera: c => `<svg viewBox="0 0 100 100"><rect x="8" y="30" width="66" height="44" rx="9" fill="none" stroke="${c}" stroke-width="7"/><circle cx="41" cy="52" r="12" fill="none" stroke="${c}" stroke-width="7"/><polygon points="74,42 94,30 94,74 74,62" fill="${c}"/></svg>`,
    railway: c => `<svg viewBox="0 0 100 100"><g stroke="${c}" stroke-width="13" stroke-linecap="round"><line x1="14" y1="14" x2="86" y2="86"/><line x1="86" y1="14" x2="14" y2="86"/></g></svg>`,
    bump: c => `<svg viewBox="0 0 100 100"><path d="M6 72 H26 Q50 18 74 72 H94" fill="none" stroke="${c}" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  };

  function glyphSVG(n) {
    const color = noteColor(n);
    if (HAZARD_GLYPHS[n.kind]) return HAZARD_GLYPHS[n.kind](color);
    if (n.kind === 'finish') {
      let cells = '';
      for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) if ((r + c) % 2 === 0) cells += `<rect x="${18 + c * 16}" y="${18 + r * 16}" width="16" height="16" fill="#fff"/>`;
      return `<svg viewBox="0 0 100 100"><rect x="18" y="18" width="64" height="64" fill="#111" stroke="#fff" stroke-width="3"/>${cells}</svg>`;
    }
    if (n.kind === 'roundabout') {
      return `<svg viewBox="0 0 100 100"><circle cx="50" cy="44" r="24" fill="none" stroke="${color}" stroke-width="9"/>
        <line x1="50" y1="96" x2="50" y2="70" stroke="${color}" stroke-width="9" stroke-linecap="round"/>
        <text x="50" y="52" text-anchor="middle" font-size="26" font-weight="800" fill="${color}" font-family="${FONT}">${n.exit || ''}</text></svg>`;
    }
    if (!n.dir) {
      const word = n.kind === 'merge' ? 'MERGE' : n.kind === 'ferry' ? 'FERRY' : '';
      return `<svg viewBox="0 0 100 100"><text x="50" y="60" text-anchor="middle" font-size="26" font-weight="800" fill="${color}" font-family="${FONT}">${word}</text></svg>`;
    }

    const angle = n.kind === 'keep' || n.kind === 'ramp' ? 30 : Math.max(25, Math.min(180, n.angle || 90));
    const r = GLYPH_RADIUS[n.kind === 'corner' ? n.grade : n.kind] || 30;
    const mods = n.mods || [];
    return curvedArrowSVG(n.dir, angle, r, color,
      mods.includes('opens') ? r * 0.5 : r,
      mods.includes('tightens') ? r * 0.45 : r);
  }

  // An arrow that comes up from the bottom and bends `angle` degrees left or
  // right; r0/r1 = bend radius at the start/end (tightening or opening).
  function curvedArrowSVG(dir, angle, r, color, r0 = r, r1 = r) {
    const sign = dir === 'L' ? -1 : 1;

    // Walk the shape: approach straight, the arc, a short exit. y points up.
    let x = 0, y = 34, h = 0;
    const pts = [[0, 0], [0, y]];
    const steps = 30;
    const dA = (angle * RAD) / steps;
    for (let k = 0; k < steps; k++) {
      const ds = (r0 + (r1 - r0) * (k + 0.5) / steps) * dA;
      const mid = h + sign * dA / 2;
      x += Math.sin(mid) * ds;
      y += Math.cos(mid) * ds;
      h += sign * dA;
      pts.push([x, y]);
    }
    x += Math.sin(h) * 12;
    y += Math.cos(h) * 12;
    pts.push([x, y]);

    const bbox = list => list.reduce((b, [px, py]) => [Math.min(b[0], px), Math.min(b[1], py), Math.max(b[2], px), Math.max(b[3], py)], [Infinity, Infinity, -Infinity, -Infinity]);
    let b = bbox(pts);
    const size = Math.max(b[2] - b[0], b[3] - b[1]);
    const head = size * 0.22;
    const tip = [x + Math.sin(h) * head, y + Math.cos(h) * head];
    const wing = [Math.cos(h) * head * 0.62, -Math.sin(h) * head * 0.62];
    const arrow = [tip, [x + wing[0], y + wing[1]], [x - wing[0], y - wing[1]]];
    b = bbox(pts.concat(arrow));

    const box = 100, pad = 12;
    const k = (box - 2 * pad) / Math.max(b[2] - b[0], b[3] - b[1]);
    const offX = (box - (b[2] - b[0]) * k) / 2;
    const offY = (box - (b[3] - b[1]) * k) / 2;
    const map = ([px, py]) => `${(offX + (px - b[0]) * k).toFixed(1)},${(box - offY - (py - b[1]) * k).toFixed(1)}`;
    return `<svg viewBox="0 0 100 100">
      <polyline points="${pts.map(map).join(' ')}" fill="none" stroke="${color}" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"/>
      <polygon points="${arrow.map(map).join(' ')}" fill="${color}" stroke="${color}" stroke-width="4" stroke-linejoin="round"/>
    </svg>`;
  }

  // ── Briefing ──

  const overview = new StageView($('overview'));
  const chase = new StageView($('chase'));

  function estimateSimTime(stage) {
    const sim = new N.Simulator(stage);
    while (!sim.done && sim.t < 36000) sim.step(1);
    return sim.t;
  }

  function loadStage(route) {
    const stage = N.buildStage(route);
    state.route = route;
    state.stage = stage;
    state.simTotal = null;
    show('brief');
    renderBrief();
  }

  // "8 traffic lights · 1 speed camera · speed limits on 90% of the route"
  function featureSummary(route, stage) {
    if (route.synthetic) return 'Demo stage: a made-up road for trying the co-driver. Use “Simulate drive”.';
    const count = {};
    for (const n of stage.notes) {
      if (HAZARD_SHORT[n.kind]) count[n.kind] = (count[n.kind] || 0) + 1;
      if (n.at) count[n.at] = (count[n.at] || 0) + 1;
    }
    const words = { lights: ['traffic light', 'traffic lights'], stop: ['stop sign', 'stop signs'], camera: ['speed camera', 'speed cameras'], railway: ['rail crossing', 'rail crossings'], bump: ['speed bump', 'speed bumps'] };
    const parts = Object.keys(words).filter(k => count[k]).map(k => `${count[k]} ${words[k][count[k] === 1 ? 0 : 1]}`);
    const covered = (stage.limits || []).reduce((sum, sp) => sum + (sp.end - sp.start), 0);
    if (covered > 0) parts.push(`speed limits on ${Math.min(100, Math.round((covered / stage.length) * 100))}% of the route`);
    const source = route.provider === 'google' ? 'Route by Google Maps' : 'Route by OpenStreetMap (OSRM)';
    let features;
    if (route.features === 'failed') features = 'Couldn’t load traffic lights and speed limits right now (map data server busy).';
    else features = parts.length ? parts.join(' · ') : 'No traffic lights, signs or speed limits mapped on this route.';
    if (route.features === 'partial') features += ' (first part of the route only)';
    return `${source}. ${features}`;
  }

  async function renderBrief() {
    const { route, stage } = state;
    $('brief-title').textContent = route.name;

    const duration = route.duration || estimateSimTime(stage);
    const alerts = stage.notes.filter(n => HAZARD_SHORT[n.kind] || n.at).length;
    const stats = [
      [fmtDist(stage.length), 'distance'],
      [fmtDuration(duration), 'drive time'],
      [stage.stats.corners, 'corners'],
      [alerts, 'road alerts'],
    ];
    $('brief-stats').innerHTML = '';
    for (const [value, label] of stats) {
      const d = document.createElement('div');
      d.innerHTML = '<b></b><span></span>';
      d.firstChild.textContent = value;
      d.lastChild.textContent = label;
      $('brief-stats').appendChild(d);
    }
    $('brief-note').textContent = featureSummary(route, stage);
    const attrib = $('attrib');
    attrib.textContent = route.synthetic ? '' : `${route.provider === 'google' ? 'Route © Google · ' : ''}${P.ATTRIBUTION} · `;
    if (!route.synthetic) {
      const fix = document.createElement('a');
      fix.href = 'https://www.openstreetmap.org/fixthemap';
      fix.target = '_blank';
      fix.rel = 'noopener';
      fix.textContent = 'Something wrong on the map? Fix it';
      attrib.appendChild(fix);
    }

    const real = !route.synthetic;
    $('btn-start').classList.toggle('hidden', !real);
    $('btn-sim').classList.toggle('btn-go', !real);
    $('btn-sim').classList.toggle('btn-alt', real);
    $('btn-gmaps').classList.toggle('hidden', !real);
    $('btn-waze').classList.toggle('hidden', !real);
    if (real) {
      const dest = route.destinationPoint || route.path[route.path.length - 1];
      $('btn-gmaps').href = googleMapsLink(dest);
      $('btn-waze').href = P.wazeLink(dest);
    }

    renderBook();

    overview.setStage(stage);
    const m = mapFor(route);
    $('overview').classList.toggle('hidden', !!m);
    $('map-slot-brief').classList.toggle('hidden', !m);
    if (m) {
      try {
        await showMapIn('map-slot-brief');
        m.drawStage(stage, MAP_STYLE);
        return;
      } catch (e) {
        console.warn('Street map unavailable', e);
        $('overview').classList.remove('hidden');
        $('map-slot-brief').classList.add('hidden');
      }
    }
    overview.drawOverview();
  }

  function renderBook() {
    const ol = $('book');
    ol.innerHTML = '';
    for (const call of state.stage.calls) {
      const li = document.createElement('li');
      const km = document.createElement('span');
      km.className = 'km';
      km.textContent = toDistUnit(call.start).toFixed(2);
      const body = document.createElement('span');
      body.className = 'call';
      call.notes.forEach((n, i) => {
        body.appendChild(pill(n));
        if (n.link && (i < call.notes.length - 1 || !/^(into|and)$/.test(n.link))) body.appendChild(linkSpan(n.link));
      });
      li.append(km, body);
      li.title = call.text;
      li.addEventListener('click', () => {
        coDriver.stop();
        coDriver.unlock();
        coDriver.say(call.text);
      });
      ol.appendChild(li);
    }
  }

  // ── Drive ──

  function startDrive(mode) {
    const stage = state.stage;
    stopDrive();
    coDriver.stop();
    coDriver.unlock();
    Object.assign(state, {
      mode,
      tracker: new N.Tracker(stage),
      scheduler: new N.CallScheduler(stage.calls, { leadTime: TIMING[settings.timing] }),
      sim: mode === 'sim' ? new N.Simulator(stage) : null,
      s: 0,
      speed: 0,
      topSpeed: 0,
      lastFixAt: 0,
      accuracy: null,
      startedAt: performance.now(),
      noteIdx: 0,
      shownNote: null,
      lastCall: '',
      finished: false,
      endArmed: false,
    });
    startGuidance(stage);

    show('drive');
    chase.setStage(stage);
    setView(mapFor(state.route) ? 'map' : 'chase');
    $('sim-badge').classList.toggle('hidden', mode !== 'sim');
    $('gps-chip').classList.toggle('hidden', mode !== 'gps');
    $('btn-speed').classList.toggle('hidden', mode !== 'sim');
    $('btn-view').classList.toggle('hidden', !mapFor(state.route));
    $('stat-speed-unit').textContent = speedUnit();
    $('stat-left-unit').textContent = `${distUnit()} left`;
    $('limit-sign').classList.add('hidden');
    $('btn-recenter').classList.add('hidden');
    setAlert(null);
    requestWakeLock();

    if (mode === 'sim') {
      // The first utterance must happen inside the tap (iOS/Chrome autoplay rules).
      coDriver.say('Three');
      countdown(['3', '2', '1', 'GO'], ['', 'Two', 'One', 'Go!'], () => {
        state.startedAt = performance.now();
        state.simTimer = setInterval(() => onFix(state.sim.step(0.1 * state.simRate)), 100);
      });
    } else {
      coDriver.say('Co-driver ready. Stage start.');
      state.watchId = navigator.geolocation.watchPosition(
        p => onFix({
          lat: p.coords.latitude,
          lng: p.coords.longitude,
          accuracy: p.coords.accuracy,
          speed: p.coords.speed,
          timestamp: p.timestamp,
        }),
        err => setAlert(err.code === 1 ? 'ALLOW LOCATION ACCESS' : 'WAITING FOR GPS'),
        { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }
      );
    }
    state.raf = requestAnimationFrame(frame);
  }

  function countdown(labels, words, done) {
    const el = $('countdown');
    let i = 0;
    const tick = () => {
      if (state.screen !== 'drive') return;
      if (i >= labels.length) {
        el.classList.add('hidden');
        done();
        return;
      }
      el.textContent = labels[i];
      el.classList.remove('hidden');
      if (words[i]) coDriver.say(words[i]);
      i++;
      state.countdownTimer = setTimeout(tick, i === labels.length ? 500 : 800);
    };
    tick();
  }

  let lastPosSave = 0;

  function onFix(fix) {
    if (state.finished || state.rerouting) return;
    const pos = state.tracker.update(fix);
    state.s = pos.s;
    state.speed = pos.speed || 0;
    state.accuracy = fix.accuracy || null;
    // Only trust top speed from a decent fix.
    if (!fix.accuracy || fix.accuracy <= 30) state.topSpeed = Math.max(state.topSpeed, state.speed);
    state.lastFixAt = performance.now();
    if (state.mode === 'gps') {
      setAlert(pos.offRoute ? 'OFF ROUTE' : null);
      if (state.lastFixAt - lastPosSave > 60000) {
        lastPosSave = state.lastFixAt;
        rememberPos(fix);
      }
    }

    if (pos.offRoute) {
      reroute(fix);
      return;
    }

    // In fast-forward the voice still talks at normal speed, so warn earlier.
    const schedSpeed = state.mode === 'sim' ? state.speed * state.simRate : state.speed;
    for (const p of settings.navVoice && state.prompter ? state.prompter.update(pos.s, schedSpeed) : []) {
      coDriver.say(p.text, () => state.s > p.s + 10);
    }
    for (const call of state.scheduler.update(pos.s, schedSpeed)) {
      state.lastCall = call.text;
      if (!settings.rallyVoice) continue;
      coDriver.say(call.text, () => state.s > call.start + 5);
      const card = $('note-card');
      card.classList.remove('flash');
      void card.offsetWidth;
      card.classList.add('flash');
    }

    const atEnd = state.mode === 'sim' ? state.sim.done : pos.s >= state.stage.length - 25;
    if (atEnd) finishStage();
  }

  async function reroute(fix) {
    if (state.mode !== 'gps' || state.route.synthetic || state.rerouting) return;
    if (performance.now() - state.lastReroute < 20000) return;
    state.rerouting = true;
    state.lastReroute = performance.now();
    coDriver.stop();
    coDriver.say('Off route. Recalculating.');
    try {
      const old = state.route;
      const dest = old.destinationPoint || old.path[old.path.length - 1];
      const route = await findRoute({ lat: fix.lat, lng: fix.lng, label: 'Here' }, { lat: dest.lat, lng: dest.lng, label: old.destLabel });
      await addRoadFeatures(route, 8000);
      Object.assign(route, { name: old.name, destinationPoint: dest, destLabel: old.destLabel });
      const stage = N.buildStage(route);
      Object.assign(state, {
        route,
        stage,
        tracker: new N.Tracker(stage),
        scheduler: new N.CallScheduler(stage.calls, { leadTime: TIMING[settings.timing] }),
        noteIdx: 0,
        shownNote: null,
        s: 0,
      });
      startGuidance(stage);
      chase.setStage(stage);
      if (maps.active && mapFor(route) === maps.active) {
        maps.active.drawStage(stage, MAP_STYLE);
        maps.active.track(true);
        updateMapCar(0, true);
      }
      setAlert(null);
      coDriver.say('New route. Notes on.');
    } catch (err) {
      console.warn('Reroute failed', err);
      coDriver.say('Could not recalculate.');
    } finally {
      state.rerouting = false;
    }
  }

  function elapsed() {
    if (state.mode === 'sim') return state.sim ? state.sim.t : 0;
    return (performance.now() - state.startedAt) / 1000;
  }

  function frame() {
    if (state.screen !== 'drive') return;
    let s = state.s;
    // GPS fixes come about once a second; glide between them.
    if (state.mode === 'gps' && state.lastFixAt) {
      const dt = Math.min(1.5, (performance.now() - state.lastFixAt) / 1000);
      s = Math.min(state.stage.length, s + state.speed * dt);
    }
    if (state.view === 'chase') chase.drawChase(s, state.speed);
    updateHud(s);
    state.raf = requestAnimationFrame(frame);
  }

  function updateHud(s) {
    const { stage } = state;
    const notes = stage.notes;
    let i = Math.min(state.noteIdx, notes.length - 1);
    while (i < notes.length - 1 && notes[i].end < s - 3) i++;
    state.noteIdx = i;
    const n = notes[i];

    if (n !== state.shownNote) {
      state.shownNote = n;
      $('note-card').style.borderColor = noteColor(n);
      $('note-glyph').innerHTML = glyphSVG(n);
      $('note-text').textContent = n.text;
      $('note-text').classList.toggle('long', n.text.length > 13);
      $('note-street').textContent = n.street ? `onto ${n.street}` : '';
      const strip = $('next-strip');
      strip.innerHTML = '';
      for (let k = i + 1; k < Math.min(notes.length, i + 4); k++) {
        if (notes[k - 1].link) strip.appendChild(linkSpan(notes[k - 1].link));
        strip.appendChild(pill(notes[k]));
      }
    }

    const d = n.start - s;
    const distText = d <= 2 ? 'NOW' : d >= 1000 ? `${(d / 1000).toFixed(1)}<small>km</small>` : `${Math.round(d / 5) * 5}<small>m</small>`;
    const distEl = $('note-dist');
    if (distEl.innerHTML !== distText) distEl.innerHTML = distText;

    const now = performance.now();
    const stale = state.mode === 'gps' && (!state.lastFixAt || now - state.lastFixAt > 5000);
    $('stat-speed').textContent = stale ? '--' : toSpeedUnit(state.speed);
    $('stat-top').textContent = state.topSpeed > 0 ? `top ${toSpeedUnit(state.topSpeed)}` : '';
    if (state.mode === 'gps') updateGpsChip(stale);
    updateLimit(s, stale);
    $('stat-left').textContent = toDistUnit(Math.max(0, stage.length - s)).toFixed(1);
    $('progress-bar').style.width = `${Math.min(100, (s / stage.length) * 100)}%`;
    updateNav(s);
    updateMapCar(s);
  }

  // ── Turn-by-turn ──

  // The rally call already says "Square right" at this junction: don't also
  // say "Turn right" at the turn (the earlier prompts still name the street).
  function rallyCoversTurn(m) {
    return settings.rallyVoice && state.stage.notes.some(n => n.junction && n.dir === m.dir && Math.abs(n.apex - m.s) < 35);
  }

  function startGuidance(stage) {
    state.guide = G.maneuvers(stage, state.route.destLabel || (state.route.synthetic ? 'the finish' : null));
    state.prompter = new G.Prompter(state.guide, { units: settings.units, skipNow: rallyCoversTurn });
    state.navIdx = 0;
    state.shownNav = null;
  }

  function remainingSeconds(s) {
    const { route, stage } = state;
    const total = route.duration || (state.simTotal || (state.simTotal = estimateSimTime(stage)));
    return total * Math.max(0, stage.length - s) / stage.length;
  }

  let lastEta = '';

  function updateNav(s) {
    const guide = state.guide;
    const banner = $('nav-banner');
    if (!guide.length) {
      banner.classList.add('hidden');
      return;
    }
    state.navIdx = G.nextIndex(guide, s, state.navIdx);
    const m = guide[state.navIdx];
    banner.classList.remove('hidden');
    if (state.shownNav !== m) {
      state.shownNav = m;
      $('nav-arrow').innerHTML = navArrowSVG(m);
      $('nav-text').textContent = G.instruction(m);
      const after = guide[state.navIdx + 1];
      const then = $('nav-then');
      if (after && after.s - m.s < 300) {
        then.innerHTML = `<span>Then</span>${navArrowSVG(after)}`;
        then.classList.remove('hidden');
      } else {
        then.classList.add('hidden');
      }
    }
    const d = m.s - s;
    const dist = G.displayDistance(d, settings.units);
    if ($('nav-dist').textContent !== dist.value) $('nav-dist').textContent = dist.value;
    if ($('nav-dist-unit').textContent !== dist.unit) $('nav-dist-unit').textContent = dist.unit;
    const lanes = $('nav-lanes');
    const showLanes = m.lanes && d < 1000;
    if (showLanes && lanes.dataset.for !== String(state.navIdx)) {
      lanes.dataset.for = String(state.navIdx);
      lanes.innerHTML = m.lanes.map(l => laneSVG((l.indications || ['straight'])[0], l.valid)).join('');
    }
    lanes.classList.toggle('hidden', !showLanes);

    const road = G.roadAt(state.stage, s);
    const roadEl = $('road-name');
    if (roadEl.textContent !== road) roadEl.textContent = road;
    roadEl.classList.toggle('hidden', !road);

    // Arrival time, minutes left.
    const left = remainingSeconds(s);
    const eta = new Date(Date.now() + left * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const sub = left >= 3600 ? `${Math.floor(left / 3600)} h ${Math.round((left % 3600) / 60)} min` : `${Math.max(0, Math.round(left / 60))} min`;
    if (eta + sub !== lastEta) {
      lastEta = eta + sub;
      $('stat-eta').textContent = eta.replace(/\s?[AP]M$/i, '');
      $('stat-eta-sub').textContent = sub;
    }
  }

  // White maneuver arrow for the green banner.
  function navArrowSVG(m) {
    const k = m.maneuver;
    if (k === 'ARRIVE') {
      return '<svg viewBox="0 0 100 100"><path d="M50 92 C50 92 20 58 20 38 a30 30 0 0 1 60 0 C80 58 50 92 50 92 Z" fill="#fff"/><circle cx="50" cy="38" r="11" fill="#13803f"/></svg>';
    }
    if (/^ROUNDABOUT/.test(k)) {
      return `<svg viewBox="0 0 100 100"><circle cx="50" cy="42" r="22" fill="none" stroke="#fff" stroke-width="9"/>
        <line x1="50" y1="96" x2="50" y2="64" stroke="#fff" stroke-width="9" stroke-linecap="round"/>
        <text x="50" y="51" text-anchor="middle" font-size="26" font-weight="800" fill="#fff" font-family="${FONT}">${m.exit || ''}</text></svg>`;
    }
    const angle = /SLIGHT|FORK|KEEP|RAMP/.test(k) ? 40 : /SHARP/.test(k) ? 135 : /UTURN/.test(k) ? 180 : /MERGE|FERRY|STRAIGHT/.test(k) ? 0 : 90;
    return curvedArrowSVG(m.dir || 'R', angle, angle >= 180 ? 14 : 22, '#fff');
  }

  // One lane: an arrow for its direction, bright if it is a lane for this maneuver.
  const LANE_ANGLE = { 'sharp left': -135, left: -90, 'slight left': -45, straight: 0, none: 0, 'slight right': 45, right: 90, 'sharp right': 135, uturn: -180 };
  function laneSVG(indication, valid) {
    const a = (LANE_ANGLE[indication] !== undefined ? LANE_ANGLE[indication] : 0) * RAD;
    const x = 20 + Math.sin(a) * 12, y = 20 - Math.cos(a) * 12;
    const hx = Math.sin(a) * 6, hy = -Math.cos(a) * 6;
    const px = Math.cos(a) * 5, py = Math.sin(a) * 5;
    const color = valid ? '#fff' : 'rgba(255,255,255,0.35)';
    return `<svg viewBox="0 0 40 44" class="lane"><path d="M20 42 V20 L${x.toFixed(1)} ${y.toFixed(1)}" fill="none" stroke="${color}" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>
      <polygon points="${(x + hx).toFixed(1)},${(y + hy).toFixed(1)} ${(x + px).toFixed(1)},${(y + py).toFixed(1)} ${(x - px).toFixed(1)},${(y - py).toFixed(1)}" fill="${color}"/></svg>`;
  }

  // Posted speed limit (from OpenStreetMap) and the speedo turning red above it.
  function updateLimit(s, stale) {
    const lim = N.limitAt(state.stage, s);
    const sign = $('limit-sign');
    const speedEl = $('stat-speed');
    if (!lim) {
      sign.classList.add('hidden');
      speedEl.classList.remove('over');
      return;
    }
    const mph = settings.units === 'mph';
    const native = mph ? lim.unit === 'mph' : lim.unit === 'km/h';
    const shown = native ? lim.value : Math.round((lim.mps * MPS_TO[settings.units]) / 5) * 5;
    sign.classList.remove('hidden');
    sign.classList.toggle('round', !mph);
    const valueEl = $('limit-value');
    if (valueEl.textContent !== String(shown)) valueEl.textContent = shown;
    const tolerance = mph ? 3 * 0.44704 : 5 / 3.6;
    speedEl.classList.toggle('over', !stale && state.speed > lim.mps + tolerance);
  }

  function updateGpsChip(stale) {
    const chip = $('gps-chip');
    const acc = state.accuracy;
    const level = stale ? 'lost' : acc === null ? 'ok' : acc <= 10 ? 'good' : acc <= 25 ? 'ok' : 'poor';
    const text = stale ? 'NO GPS' : acc === null ? 'GPS' : `GPS ±${Math.round(acc)} m`;
    if (chip.textContent !== text) chip.textContent = text;
    chip.className = `gps-chip ${level}`;
    if (stale && state.lastFixAt && $('offroute').classList.contains('hidden')) setAlert('WAITING FOR GPS');
  }

  function setAlert(text) {
    const el = $('offroute');
    el.textContent = text || '';
    el.classList.toggle('hidden', !text);
  }

  async function setView(view) {
    state.view = view;
    const map = view === 'map';
    $('chase').classList.toggle('hidden', map);
    $('map-slot-drive').classList.toggle('hidden', !map);
    $('btn-overview').classList.toggle('hidden', !map);
    if (!map) $('btn-recenter').classList.add('hidden');
    $('btn-view').firstChild.textContent = map ? '◭' : '🗺';
    $('btn-view').lastChild.textContent = map ? 'Rally' : 'Map';
    if (map) {
      try {
        const m = await showMapIn('map-slot-drive');
        m.track(true);
        updateMapCar(state.s, true);
      } catch (e) {
        console.warn('Map view unavailable', e);
        setView('chase');
      }
    }
  }

  function recenter() {
    if (!maps.active) return;
    maps.active.track(true);
    $('btn-recenter').classList.add('hidden');
    updateMapCar(state.s, true);
  }

  function stopDrive() {
    clearInterval(state.simTimer);
    clearTimeout(state.countdownTimer);
    cancelAnimationFrame(state.raf);
    if (state.watchId !== null && navigator.geolocation) navigator.geolocation.clearWatch(state.watchId);
    state.simTimer = null;
    state.watchId = null;
    $('countdown').classList.add('hidden');
    if (maps.active) maps.active.clearCar();
    releaseWakeLock();
  }

  function finishStage() {
    state.finished = true;
    const time = elapsed();
    stopDrive();
    coDriver.say('Stage complete.');
    const avg = time > 0 ? state.stage.length / time : 0;
    const rows = [
      [fmtClock(time), 'time'],
      [fmtDist(state.stage.length), 'distance'],
      [`${toSpeedUnit(avg)} ${speedUnit()}`, 'average speed'],
      [`${toSpeedUnit(state.topSpeed)} ${speedUnit()}`, 'top speed'],
    ];
    const box = $('finish-stats');
    box.innerHTML = '';
    for (const [value, label] of rows) {
      const d = document.createElement('div');
      d.innerHTML = '<b></b><span></span>';
      d.firstChild.textContent = value;
      d.lastChild.textContent = label;
      box.appendChild(d);
    }
    show('finish');
  }

  // ── Wake lock: keep the screen on (GPS stops when it turns off) ──

  let wakeLock = null;

  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator && document.visibilityState === 'visible') wakeLock = await navigator.wakeLock.request('screen');
    } catch (e) {
      wakeLock = null;
    }
  }

  function releaseWakeLock() {
    if (wakeLock) wakeLock.release().catch(() => {});
    wakeLock = null;
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.screen === 'drive') requestWakeLock();
  });

  // ── Wiring ──

  async function buildStageFromForm() {
    const destText = $('destination').value.trim();
    const originText = $('origin').value.trim();
    if (!destText) return;
    const btn = $('btn-build');
    btn.disabled = true;
    try {
      let from;
      if (picked.origin && picked.origin.label === originText) from = picked.origin;
      else if (originText) from = { text: originText };
      else {
        setStatus('Finding your position…');
        from = Object.assign(await currentPosition(), { label: 'My location' });
      }
      const to = picked.destination && picked.destination.label === destText ? Object.assign({}, picked.destination) : { text: destText };

      setStatus('Finding the fastest route…');
      const route = await findRoute(from, to);
      setStatus('Checking traffic lights, signs and speed limits…');
      await addRoadFeatures(route, 20000);
      const end = route.path[route.path.length - 1];
      Object.assign(route, {
        name: `${shortPlace(from.label || from.text)} → ${shortPlace(to.label || to.text)}`,
        destinationPoint: route.destinationPoint || (to.lat !== undefined ? { lat: to.lat, lng: to.lng } : end),
        destLabel: to.label || to.text,
      });
      writeStore('rally.lastDestination', destText);
      writeStore('rally.lastOrigin', originText);
      rememberDestination(Object.assign({}, route.destinationPoint, { label: to.label || to.text }));
      setStatus('');
      loadStage(route);
    } catch (err) {
      console.warn(err);
      setStatus(friendlyError(err), true);
    } finally {
      btn.disabled = false;
    }
  }

  function initSetup() {
    $('key-hint').textContent = HAS_KEY
      ? 'Routing with Google Maps (falls back to OpenStreetMap if Google fails).'
      : 'Routing with free OpenStreetMap data — no account or key needed.';
    $('destination').value = readStore('rally.lastDestination', '');
    $('origin').value = readStore('rally.lastOrigin', '');
    $('btn-here').classList.toggle('on', !$('origin').value);
    $('avoid-highways').checked = !!settings.avoidHighways;

    attachSuggest($('origin'), $('suggest-origin'), 'origin');
    attachSuggest($('destination'), $('suggest-destination'), 'destination');

    $('btn-here').addEventListener('click', () => {
      $('origin').value = '';
      picked.origin = null;
      $('btn-here').classList.add('on');
      $('destination').focus();
    });
    $('origin').addEventListener('input', () => $('btn-here').classList.toggle('on', !$('origin').value.trim()));
    $('avoid-highways').addEventListener('change', e => {
      settings.avoidHighways = e.target.checked;
      saveSettings();
    });

    $('route-form').addEventListener('submit', e => {
      e.preventDefault();
      // Unlock audio now, inside the tap, so the briefing can talk.
      coDriver.unlock();
      buildStageFromForm();
    });

    $('btn-demo').addEventListener('click', () => {
      setStatus('');
      loadStage(window.DemoStage.build());
    });

    // Settings
    const rate = $('rate');
    rate.value = settings.rate;
    $('rate-out').textContent = `${(+settings.rate).toFixed(2)}×`;
    rate.addEventListener('input', () => {
      settings.rate = +rate.value;
      $('rate-out').textContent = `${settings.rate.toFixed(2)}×`;
      saveSettings();
    });
    $('voice').addEventListener('change', e => {
      settings.voiceURI = e.target.value;
      saveSettings();
    });
    for (const id of ['timing', 'units']) {
      const group = $(id);
      const sync = () => group.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.value === settings[id]));
      group.addEventListener('click', e => {
        const b = e.target.closest('button');
        if (!b) return;
        settings[id] = b.dataset.value;
        saveSettings();
        sync();
      });
      sync();
    }
    $('radio').checked = !!settings.radio;
    $('radio').addEventListener('change', e => {
      settings.radio = e.target.checked;
      saveSettings();
    });
    for (const [id, key] of [['nav-voice', 'navVoice'], ['rally-voice', 'rallyVoice']]) {
      $(id).checked = !!settings[key];
      $(id).addEventListener('change', e => {
        settings[key] = e.target.checked;
        saveSettings();
      });
    }
    $('mix-music').checked = !!settings.mixMusic;
    $('mix-music').addEventListener('change', e => {
      settings.mixMusic = e.target.checked;
      saveSettings();
    });
    $('btn-test-voice').addEventListener('click', () => {
      coDriver.stop();
      coDriver.unlock();
      coDriver.say('4 left, 100, 3 right tightens 2, caution, hairpin left.');
    });
  }

  function initBrief() {
    $('btn-brief-back').addEventListener('click', () => {
      coDriver.stop();
      show('setup');
    });
    $('btn-start').addEventListener('click', () => {
      if (!navigator.geolocation) {
        alert('This browser has no GPS access.');
        return;
      }
      startDrive('gps');
    });
    $('btn-sim').addEventListener('click', () => {
      state.simRate = 1;
      $('btn-speed').firstChild.textContent = '1×';
      startDrive('sim');
    });
    window.addEventListener('resize', () => {
      if (state.screen === 'brief' && !$('overview').classList.contains('hidden')) overview.drawOverview();
      if (maps.active) maps.active.resize();
    });
  }

  function initDrive() {
    $('btn-mute').addEventListener('click', () => {
      coDriver.muted = !coDriver.muted;
      if (coDriver.muted) coDriver.stop();
      $('btn-mute').setAttribute('aria-pressed', String(coDriver.muted));
      $('btn-mute').firstChild.textContent = coDriver.muted ? '🔇' : '🔊';
    });
    const repeat = () => {
      if (!state.lastCall) return;
      coDriver.stop();
      coDriver.unlock();
      coDriver.say(state.lastCall);
    };
    $('btn-repeat').addEventListener('click', repeat);
    $('note-card').addEventListener('click', repeat);
    $('btn-view').addEventListener('click', () => setView(state.view === 'map' ? 'chase' : 'map'));
    $('btn-recenter').addEventListener('click', recenter);
    $('btn-overview').addEventListener('click', () => {
      if (!maps.active) return;
      maps.active.overview();
      $('btn-recenter').classList.remove('hidden');
    });
    $('btn-speed').addEventListener('click', () => {
      state.simRate = SIM_RATES[(SIM_RATES.indexOf(state.simRate) + 1) % SIM_RATES.length];
      $('btn-speed').firstChild.textContent = `${state.simRate}×`;
    });
    // Two taps to end, so a bump on a rough road doesn't end the stage.
    $('btn-end').addEventListener('click', () => {
      const btn = $('btn-end');
      if (!state.endArmed) {
        state.endArmed = true;
        btn.lastChild.textContent = 'Sure?';
        setTimeout(() => {
          state.endArmed = false;
          btn.lastChild.textContent = 'End';
        }, 2500);
        return;
      }
      state.endArmed = false;
      btn.lastChild.textContent = 'End';
      stopDrive();
      coDriver.stop();
      show('brief');
      renderBrief();
    });
  }

  function initFinish() {
    $('btn-again').addEventListener('click', () => startDrive(state.mode || 'sim'));
    $('btn-new').addEventListener('click', () => show('setup'));
  }

  // The recorded voice pack is optional; without voice/manifest.json nothing loads.
  async function loadVoicePack() {
    try {
      const res = await fetch('voice/manifest.json', { method: 'HEAD', cache: 'no-cache' });
      if (!res.ok || !intercom.supported) return;
      intercom.ensure();
      await voicePack.load(intercom.ctx);
      fillVoiceSelect();
    } catch (e) { /* offline or no pack */ }
  }

  // Installable phone app (Add to Home Screen) that opens without a network.
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || /^(localhost|127\.0\.0\.1)$/.test(location.hostname))) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }

  coDriver.init();
  fillVoiceSelect();
  initSetup();
  initBrief();
  initDrive();
  initFinish();
  loadVoicePack();
})();
