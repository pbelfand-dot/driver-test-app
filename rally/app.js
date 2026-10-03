/*
 * Rally Co-Driver GPS: screens, Google Maps routing, the co-driver voice and
 * the driving HUD. The pace-note maths lives in pacenotes.js.
 */
(function () {
  'use strict';

  const N = window.RallyNotes;
  const $ = id => document.getElementById(id);

  const RAD = Math.PI / 180;
  const MPS_TO = { mph: 2.23694, kmh: 3.6 };
  const TIMING = { early: 7, normal: 5, late: 3.5 };   // seconds of warning before a corner
  const SIM_RATES = [1, 2, 4];
  const GRADE_COLORS = { 1: '#ff2d2d', 2: '#ff6a00', 3: '#ffa200', 4: '#ffd500', 5: '#9be15d', 6: '#3ddc84' };

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
  }, readStore('rally.settings', {}));

  const intercom = new window.CoDriverAudio.Intercom();
  const voicePack = new window.CoDriverAudio.VoicePack('voice/');

  const saveSettings = () => writeStore('rally.settings', settings);

  // ── App state ──

  const state = {
    screen: 'setup',
    route: null,       // {path, steps, duration, name, origin, destination, synthetic}
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
    callsMade: 0,
    finished: false,
    rerouting: false,
    lastReroute: -Infinity,
    view: 'chase',     // 'chase' (canvas) | 'map' (Google map)
    endArmed: false,
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

  function noteColor(n) {
    switch (n.kind) {
      case 'corner': return GRADE_COLORS[n.grade];
      case 'hairpin': return GRADE_COLORS[1];
      case 'square': return '#ff5a36';
      case 'finish': return '#ffffff';
      default: return '#4fc3f7';
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
      default: t = n.text;
    }
    return n.caution ? `⚠ ${t}` : t;
  }

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
      intercom.ensure();
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
      if (this.muted || !this.supported || !text) return;
      this.queue.push({ text, isStale });
      this.pump();
    },

    pump() {
      if (this.current) return;
      let item = this.queue.shift();
      while (item && item.isStale && item.isStale()) item = this.queue.shift();
      if (!item) return;

      // Recorded co-driver voice pack, when one is installed and has every word.
      if (!settings.voiceURI && intercom.ctx && voicePack.canSay(item.text)) {
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

    stop() {
      this.queue = [];
      this.current = null;
      if (this.playing) this.playing.stop();
      this.playing = null;
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
    sel.appendChild(new Option(voicePack.ready ? 'Recorded co-driver (Higgsfield voice pack)' : 'Auto (British English if available)', ''));
    for (const v of list) sel.appendChild(new Option(`${v.name} (${v.lang})`, v.voiceURI));
    sel.value = list.some(v => v.voiceURI === settings.voiceURI) ? settings.voiceURI : '';
  }

  // ── Google Maps ──

  let mapsPromise = null;

  function loadMaps() {
    if (!HAS_KEY) return Promise.reject(new Error('Add a Google Maps API key to config.js to build routes (or try the demo stage).'));
    if (!mapsPromise) {
      mapsPromise = new Promise((resolve, reject) => {
        window.__rallyMapsReady = () => resolve(window.google.maps);
        window.gm_authFailure = () => setStatus('Google rejected the API key. Check that Maps JavaScript API and Routes API are enabled and the key allows this website.', true);
        const s = document.createElement('script');
        s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(KEY)}&v=weekly&loading=async&callback=__rallyMapsReady`;
        s.async = true;
        s.onerror = () => {
          mapsPromise = null;
          reject(new Error('Could not load Google Maps. Check your internet connection.'));
        };
        document.head.appendChild(s);
      });
    }
    return mapsPromise;
  }

  const toLL = p => (typeof p.lat === 'function' ? { lat: p.lat(), lng: p.lng() } : { lat: +p.lat, lng: +p.lng });

  // Glue per-step paths into one route path, remembering where each maneuver starts.
  function joinSteps(steps, fallbackPath, duration) {
    const path = [];
    const out = [];
    for (const st of steps) {
      const pts = (st.path || []).map(toLL);
      if (!pts.length) continue;
      const last = path[path.length - 1];
      const dup = last && Math.abs(last.lat - pts[0].lat) < 1e-7 && Math.abs(last.lng - pts[0].lng) < 1e-7;
      out.push({ index: dup ? path.length - 1 : path.length, maneuver: st.maneuver, instruction: st.instruction });
      for (let i = dup ? 1 : 0; i < pts.length; i++) path.push(pts[i]);
    }
    if (path.length < 2) return { path: (fallbackPath || []).map(toLL), steps: [], duration };
    return { path, steps: out, duration };
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
    return joinSteps(steps, r.path, r.durationMillis ? r.durationMillis / 1000 : null);
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
    return joinSteps(steps, r.overview_path, duration || null);
  }

  function friendlyRouteError(err) {
    const msg = String((err && (err.message || err.code)) || err);
    if (/NO_ROUTE|ZERO_RESULTS|NOT_FOUND|no route/i.test(msg)) {
      return new Error("Couldn't find a driving route between those places. Try a more specific address.");
    }
    if (/not been used|disabled|not activated|PERMISSION_DENIED|REQUEST_DENIED|not authorized|API key/i.test(msg)) {
      return new Error('Google refused the route request. In Google Cloud Console, enable "Routes API" for this key (and allow this website if the key is restricted).');
    }
    return new Error(`Routing failed: ${msg}`);
  }

  async function fetchRoute(origin, destination) {
    await loadMaps();
    let firstError;
    try {
      return await routeWithRoutesLibrary(origin, destination);
    } catch (err) {
      firstError = err;
      console.warn('Routes library failed, trying the legacy DirectionsService', err);
    }
    try {
      return await routeWithDirectionsService(origin, destination);
    } catch (err) {
      console.warn('DirectionsService failed too', err);
      throw friendlyRouteError(/NOT_FOUND|ZERO_RESULTS/.test(String(err && (err.code || err.message))) ? err : firstError);
    }
  }

  function currentPosition() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error('This browser has no GPS access. Type a start address instead.'));
        return;
      }
      navigator.geolocation.getCurrentPosition(
        p => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
        err => reject(new Error(err.code === 1
          ? 'Location permission was denied. Allow it, or type a start address.'
          : 'Could not get your position. Type a start address instead.')),
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 }
      );
    });
  }

  function googleMapsLink(route) {
    const p = new URLSearchParams({ api: '1', destination: route.destination, travelmode: 'driving', dir_action: 'navigate' });
    if (typeof route.origin === 'string' && route.origin) p.set('origin', route.origin);
    return `https://www.google.com/maps/dir/?${p}`;
  }

  // ── Google map display ──

  const DARK_STYLE = [
    { elementType: 'geometry', stylers: [{ color: '#15191f' }] },
    { elementType: 'labels.text.fill', stylers: [{ color: '#8b95a5' }] },
    { elementType: 'labels.text.stroke', stylers: [{ color: '#0b0d10' }] },
    { featureType: 'poi', stylers: [{ visibility: 'off' }] },
    { featureType: 'transit', stylers: [{ visibility: 'off' }] },
    { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#2a313c' }] },
    { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#3a4250' }] },
    { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#0a1a2a' }] },
  ];

  const gm = { map: null, Overlay: null, layers: [], car: null };

  async function ensureMap() {
    await loadMaps();
    if (gm.map) return gm.map;
    const { Map, OverlayView } = await google.maps.importLibrary('maps');
    gm.Overlay = class HtmlOverlay extends OverlayView {
      constructor(pos, el) {
        super();
        this.pos = pos;
        this.el = el;
      }
      onAdd() { this.getPanes().floatPane.appendChild(this.el); }
      onRemove() { this.el.remove(); }
      draw() {
        const proj = this.getProjection();
        const p = proj && proj.fromLatLngToDivPixel(new google.maps.LatLng(this.pos));
        if (!p) return;
        this.el.style.left = `${p.x}px`;
        this.el.style.top = `${p.y}px`;
      }
      setPosition(pos) {
        this.pos = pos;
        this.draw();
      }
    };
    gm.map = new Map($('gmap'), {
      center: { lat: 40.79, lng: -73.13 },
      zoom: 10,
      disableDefaultUI: true,
      zoomControl: true,
      gestureHandling: 'greedy',
      clickableIcons: false,
      backgroundColor: '#07090c',
      styles: DARK_STYLE,
    });
    return gm.map;
  }

  function placeMap(slotId) {
    $(slotId).appendChild($('gmap'));
  }

  function drawStageOnMap(stage) {
    const map = gm.map;
    gm.layers.forEach(l => l.setMap(null));
    gm.layers = [];
    const S = stage.samples;
    const slice = (a, b) => S.slice(N.indexAt(S, a), N.indexAt(S, b) + 2).map(p => ({ lat: p.lat, lng: p.lng }));

    gm.layers.push(new google.maps.Polyline({
      map, path: S.map(p => ({ lat: p.lat, lng: p.lng })), strokeColor: '#ffcc00', strokeOpacity: 0.55, strokeWeight: 5,
    }));
    for (const n of stage.notes) {
      if (n.type !== 'corner') continue;
      gm.layers.push(new google.maps.Polyline({
        map, path: slice(n.start, n.end), strokeColor: noteColor(n), strokeOpacity: 1, strokeWeight: 7, zIndex: 2,
      }));
    }
    for (const n of stage.notes) {
      const el = document.createElement('div');
      el.className = 'map-label';
      el.style.background = noteColor(n);
      el.textContent = n.kind === 'finish' ? '🏁' : shortLabel(n).replace('⚠ ', '');
      const overlay = new gm.Overlay(N.pointAt(S, n.apex !== undefined ? n.apex : n.start), el);
      overlay.setMap(map);
      gm.layers.push(overlay);
    }

    let north = -90, south = 90, east = -180, west = 180;
    for (const p of S) {
      north = Math.max(north, p.lat); south = Math.min(south, p.lat);
      east = Math.max(east, p.lng); west = Math.min(west, p.lng);
    }
    map.fitBounds({ north, south, east, west }, 30);
  }

  function updateMapCar(s) {
    if (!gm.map || state.view !== 'map') return;
    const p = N.pointAt(state.stage.samples, s);
    if (!gm.car) {
      const el = document.createElement('div');
      el.className = 'map-car';
      gm.car = new gm.Overlay(p, el);
      gm.car.setMap(gm.map);
    }
    gm.car.setPosition(p);
    gm.car.el.style.transform = `rotate(${N.headingAt(state.stage.samples, s, 15)}deg)`;
    gm.map.panTo(p);
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

    // Whole stage, north up — used on the briefing screen without a Google map.
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
      const order = notes.filter(n => n.type === 'corner').sort((a, b) => severity(a) - severity(b));
      for (const n of order) {
        const p = project(this.xy[N.indexAt(this.stage.samples, n.apex)]);
        this.label(p[0], p[1] - 16, shortLabel(n).replace('⚠ ', ''), noteColor(n), placed);
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
        const side = n.dir === 'L' ? -1 : 1;
        this.label(p[0] + side * (roadW + 26), p[1], shortLabel(n).replace('⚠ ', ''), noteColor(n), placed);
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

  // Lower = slower corner; used to give slow corners label priority.
  function severity(n) {
    if (n.kind === 'hairpin') return 0;
    if (n.kind === 'square') return 1;
    return n.grade || 9;
  }

  // ── Note glyph (the corner arrow on the HUD) ──

  const GLYPH_RADIUS = { hairpin: 10, square: 3, keep: 60, ramp: 60, 1: 12, 2: 17, 3: 24, 4: 32, 5: 44, 6: 60 };

  function glyphSVG(n) {
    const color = noteColor(n);
    if (n.kind === 'finish') {
      let cells = '';
      for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) if ((r + c) % 2 === 0) cells += `<rect x="${18 + c * 16}" y="${18 + r * 16}" width="16" height="16" fill="#fff"/>`;
      return `<svg viewBox="0 0 100 100"><rect x="18" y="18" width="64" height="64" fill="#111" stroke="#fff" stroke-width="3"/>${cells}</svg>`;
    }
    if (n.kind === 'roundabout') {
      return `<svg viewBox="0 0 100 100"><circle cx="50" cy="44" r="24" fill="none" stroke="${color}" stroke-width="9"/>
        <line x1="50" y1="96" x2="50" y2="70" stroke="${color}" stroke-width="9" stroke-linecap="round"/>
        <text x="50" y="52" text-anchor="middle" font-size="26" font-weight="800" fill="${color}" font-family="Barlow Condensed, sans-serif">${n.exit || ''}</text></svg>`;
    }
    if (!n.dir) {
      const word = n.kind === 'merge' ? 'MERGE' : n.kind === 'ferry' ? 'FERRY' : '';
      return `<svg viewBox="0 0 100 100"><text x="50" y="60" text-anchor="middle" font-size="26" font-weight="800" fill="${color}" font-family="Barlow Condensed, sans-serif">${word}</text></svg>`;
    }

    const angle = n.kind === 'keep' || n.kind === 'ramp' ? 30 : Math.max(25, Math.min(180, n.angle || 90));
    const r = GLYPH_RADIUS[n.kind === 'corner' ? n.grade : n.kind] || 30;
    const mods = n.mods || [];
    const r0 = mods.includes('opens') ? r * 0.5 : r;
    const r1 = mods.includes('tightens') ? r * 0.45 : r;
    const sign = n.dir === 'R' ? 1 : -1;

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
    show('brief');
    renderBrief();
  }

  async function renderBrief() {
    const { route, stage } = state;
    $('brief-title').textContent = route.name;

    const duration = route.duration || estimateSimTime(stage);
    const perUnit = stage.stats.corners / Math.max(0.1, toDistUnit(stage.length));
    const stats = [
      [fmtDist(stage.length), 'distance'],
      [fmtDuration(duration), 'drive time'],
      [stage.stats.corners, 'corners'],
      [perUnit.toFixed(1), `per ${distUnit()}`],
    ];
    $('brief-stats').innerHTML = '';
    for (const [value, label] of stats) {
      const d = document.createElement('div');
      d.innerHTML = '<b></b><span></span>';
      d.firstChild.textContent = value;
      d.lastChild.textContent = label;
      $('brief-stats').appendChild(d);
    }

    $('btn-start').classList.toggle('hidden', !!route.synthetic);
    $('btn-sim').classList.toggle('btn-go', !!route.synthetic);
    $('btn-sim').classList.toggle('btn-alt', !route.synthetic);
    $('btn-sim').style.gridColumn = route.synthetic ? '1 / -1' : '';
    const gl = $('btn-gmaps');
    gl.classList.toggle('hidden', !!route.synthetic);
    if (!route.synthetic) gl.href = googleMapsLink(route);

    renderBook();

    overview.setStage(stage);
    const useGoogle = !route.synthetic && HAS_KEY;
    $('overview').classList.toggle('hidden', useGoogle);
    $('map-slot-brief').classList.toggle('hidden', !useGoogle);
    if (useGoogle) {
      try {
        await ensureMap();
        placeMap('map-slot-brief');
        drawStageOnMap(stage);
      } catch (e) {
        $('overview').classList.remove('hidden');
        $('map-slot-brief').classList.add('hidden');
        overview.drawOverview();
      }
    } else {
      overview.drawOverview();
    }
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
      callsMade: 0,
      finished: false,
      endArmed: false,
    });

    show('drive');
    chase.setStage(stage);
    setView('chase');
    $('sim-badge').classList.toggle('hidden', mode !== 'sim');
    $('gps-chip').classList.toggle('hidden', mode !== 'gps');
    $('btn-speed').classList.toggle('hidden', mode !== 'sim');
    $('btn-view').classList.toggle('hidden', !!state.route.synthetic || !HAS_KEY);
    $('btn-end').firstChild.textContent = '■';
    $('stat-speed-unit').textContent = speedUnit();
    $('stat-left-unit').textContent = `${distUnit()} left`;
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

  function onFix(fix) {
    if (state.finished || state.rerouting) return;
    const pos = state.tracker.update(fix);
    state.s = pos.s;
    state.speed = pos.speed || 0;
    state.accuracy = fix.accuracy || null;
    // Only trust top speed from a decent fix.
    if (!fix.accuracy || fix.accuracy <= 30) state.topSpeed = Math.max(state.topSpeed, state.speed);
    state.lastFixAt = performance.now();
    if (state.mode === 'gps') setAlert(pos.offRoute ? 'OFF ROUTE' : null);

    if (pos.offRoute) {
      reroute(fix);
      return;
    }

    // In fast-forward the voice still talks at normal speed, so warn earlier.
    const schedSpeed = state.mode === 'sim' ? state.speed * state.simRate : state.speed;
    for (const call of state.scheduler.update(pos.s, schedSpeed)) {
      state.lastCall = call.text;
      state.callsMade++;
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
      const route = await fetchRoute({ lat: fix.lat, lng: fix.lng }, old.destination);
      Object.assign(route, { name: old.name, origin: old.origin, destination: old.destination });
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
      chase.setStage(stage);
      if (gm.map) drawStageOnMap(stage);
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

  let lastMapPan = 0;

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
    $('stat-time').textContent = fmtClock(elapsed());
    $('stat-left').textContent = toDistUnit(Math.max(0, stage.length - s)).toFixed(1);
    $('progress-bar').style.width = `${Math.min(100, (s / stage.length) * 100)}%`;

    if (state.view === 'map' && now - lastMapPan > 500) {
      lastMapPan = now;
      updateMapCar(s);
    }
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
    $('btn-view').firstChild.textContent = map ? '◭' : '🗺';
    $('btn-view').lastChild.textContent = map ? 'Notes' : 'Map';
    if (map) {
      try {
        await ensureMap();
        placeMap('map-slot-drive');
        gm.map.setZoom(17);
        updateMapCar(state.s);
      } catch (e) {
        setView('chase');
      }
    }
  }

  function stopDrive() {
    clearInterval(state.simTimer);
    clearTimeout(state.countdownTimer);
    cancelAnimationFrame(state.raf);
    if (state.watchId !== null && navigator.geolocation) navigator.geolocation.clearWatch(state.watchId);
    state.simTimer = null;
    state.watchId = null;
    $('countdown').classList.add('hidden');
    if (gm.car) {
      gm.car.setMap(null);
      gm.car = null;
    }
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

  function initSetup() {
    $('key-hint').classList.toggle('hidden', HAS_KEY);
    $('destination').value = readStore('rally.lastDestination', '');
    $('origin').value = readStore('rally.lastOrigin', '');
    $('btn-here').classList.toggle('on', !$('origin').value);
    $('avoid-highways').checked = !!settings.avoidHighways;

    $('btn-here').addEventListener('click', () => {
      $('origin').value = '';
      $('btn-here').classList.add('on');
      $('destination').focus();
    });
    $('origin').addEventListener('input', () => $('btn-here').classList.toggle('on', !$('origin').value.trim()));
    $('avoid-highways').addEventListener('change', e => {
      settings.avoidHighways = e.target.checked;
      saveSettings();
    });

    $('route-form').addEventListener('submit', async e => {
      e.preventDefault();
      const destination = $('destination').value.trim();
      const originText = $('origin').value.trim();
      if (!destination) return;
      const btn = $('btn-build');
      btn.disabled = true;
      try {
        if (!HAS_KEY) throw new Error('Add a Google Maps API key to config.js to build real routes. Meanwhile, try the demo stage below.');
        setStatus(originText ? 'Asking Google for the route…' : 'Finding your position…');
        const origin = originText || await currentPosition();
        setStatus('Asking Google for the route…');
        const route = await fetchRoute(origin, destination);
        Object.assign(route, { name: `${originText || 'My location'} → ${destination}`, origin, destination });
        writeStore('rally.lastDestination', destination);
        writeStore('rally.lastOrigin', originText);
        setStatus('');
        loadStage(route);
      } catch (err) {
        setStatus(err.message, true);
      } finally {
        btn.disabled = false;
      }
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

  // A recorded voice pack is optional; without voice/manifest.json nothing loads.
  async function loadVoicePack() {
    try {
      const res = await fetch('voice/manifest.json', { method: 'HEAD', cache: 'no-cache' });
      if (!res.ok || !intercom.supported) return;
      intercom.ensure();
      if (await voicePack.load(intercom.ctx)) fillVoiceSelect();
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
