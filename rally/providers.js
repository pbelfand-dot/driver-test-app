/*
 * Free, key-less map services from the OpenStreetMap ecosystem.
 *
 *   Address search  Photon (photon.komoot.io), falling back to Nominatim
 *   Driving routes  OSRM — FOSSGIS routing.openstreetmap.de, falling back to
 *                   the OSRM demo server
 *   Road features   Overpass API — traffic lights, stop signs, speed cameras,
 *                   rail crossings, speed bumps and speed limits along a route
 *
 * These public servers are free for light personal use. The app makes one
 * route request and a few feature requests per stage; keep it that way.
 *
 * Parsing functions are pure so they can be tested in Node; the fetchers need
 * a browser (or any global fetch).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MapProviders = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const PHOTON = 'https://photon.komoot.io/api/';
  const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
  const OSRM_HOSTS = [
    'https://routing.openstreetmap.de/routed-car/route/v1/driving/',
    'https://router.project-osrm.org/route/v1/driving/',
  ];
  const OVERPASS_HOSTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
  ];

  async function fetchJSON(url, opts = {}, timeoutMs = 12000) {
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl && setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, Object.assign({}, opts, ctrl ? { signal: ctrl.signal } : {}));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // ── Glue Google-style steps into one route ────────────────

  const toLL = p => (typeof p.lat === 'function' ? { lat: p.lat(), lng: p.lng() } : { lat: +p.lat, lng: +p.lng });

  // steps: [{path, maneuver, instruction}] → {path, steps: [{index, maneuver, instruction}], duration}
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

  // ── Address search ────────────────────────────────────────

  function photonLabel(p) {
    const street = [p.housenumber, p.street].filter(Boolean).join(' ');
    const head = p.name && p.name !== street ? p.name : street;
    const place = p.city || p.town || p.village || p.district || p.county;
    const parts = [head, head && street && head !== street ? street : null, place, p.state].filter(Boolean);
    return parts.filter((x, i) => parts.indexOf(x) === i).join(', ') || p.country || 'Unnamed place';
  }

  function parsePhoton(json) {
    return ((json && json.features) || [])
      .filter(f => f.geometry && Array.isArray(f.geometry.coordinates))
      .map(f => ({ lat: +f.geometry.coordinates[1], lng: +f.geometry.coordinates[0], label: photonLabel(f.properties || {}) }));
  }

  function parseNominatim(json) {
    return (Array.isArray(json) ? json : []).map(r => ({ lat: +r.lat, lng: +r.lon, label: r.display_name }));
  }

  // Places matching `query`, nearest-first when `near` ({lat, lng}) is known.
  // Search-as-you-type must pass {typing: true}: Nominatim's usage policy
  // forbids autocomplete, so only Photon is used then.
  async function searchPlaces(query, near, limit = 5, opts = {}) {
    const q = encodeURIComponent(query.trim());
    if (!q) return [];
    const bias = near ? `&lat=${near.lat.toFixed(4)}&lon=${near.lng.toFixed(4)}` : '';
    try {
      const found = parsePhoton(await fetchJSON(`${PHOTON}?q=${q}&limit=${limit}&lang=en${bias}`, {}, 8000));
      if (found.length || opts.typing) return found;
    } catch (e) {
      if (opts.typing) return [];
    }
    const box = near ? `&viewbox=${near.lng - 1},${near.lat + 1},${near.lng + 1},${near.lat - 1}` : '';
    return parseNominatim(await fetchJSON(`${NOMINATIM}?q=${q}&format=jsonv2&limit=${limit}${box}`, {}, 10000));
  }

  // ── Routing (OSRM) ────────────────────────────────────────

  const ORDINAL = n => `${n}${n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th'}`;

  // OSRM maneuver → the Google Routes maneuver names the pace-note engine understands.
  function osrmManeuver(m) {
    const mod = m.modifier || '';
    const side = /left/.test(mod) ? 'LEFT' : /right/.test(mod) ? 'RIGHT' : '';
    switch (m.type) {
      case 'depart': return 'DEPART';
      case 'turn':
      case 'end of road':
      case 'continue':
        if (mod === 'uturn') return 'UTURN_LEFT';
        if (!side) return '';
        if (/sharp/.test(mod)) return `TURN_SHARP_${side}`;
        // A "continue slight left" is just the road bending; the geometry covers it.
        if (/slight/.test(mod)) return m.type === 'continue' ? '' : `TURN_SLIGHT_${side}`;
        return `TURN_${side}`;
      case 'fork': return side ? `FORK_${side}` : '';
      case 'on ramp':
      case 'off ramp': return side ? `RAMP_${side}` : '';
      case 'merge': return 'MERGE';
      case 'roundabout':
      case 'rotary':
      case 'roundabout turn': return 'ROUNDABOUT_RIGHT';
      default: return '';
    }
  }

  function osrmInstruction(st, maneuver) {
    const name = st.name || st.ref || '';
    const onto = name ? ` onto ${name}` : '';
    if (/^ROUNDABOUT/.test(maneuver)) return `At the roundabout, take the ${ORDINAL((st.maneuver && st.maneuver.exit) || 1)} exit${onto}`;
    if (/^(TURN|UTURN)_/.test(maneuver)) return `Turn ${(st.maneuver.modifier || '').replace('uturn', 'around')}${onto}`;
    if (/^(FORK|RAMP)_/.test(maneuver)) return `Keep ${/LEFT$/.test(maneuver) ? 'left' : 'right'}${onto}`;
    if (maneuver === 'MERGE') return `Merge${onto}`;
    return `Continue${onto}`;
  }

  // OSRM /route JSON → {path, steps, duration}
  function parseOsrm(json) {
    if (!json || json.code !== 'Ok' || !json.routes || !json.routes.length) {
      throw new Error((json && json.code) === 'NoRoute' ? 'NO_ROUTE' : `OSRM: ${(json && (json.message || json.code)) || 'no response'}`);
    }
    const r = json.routes[0];
    const steps = [];
    for (const leg of r.legs || []) {
      for (const st of leg.steps || []) {
        const maneuver = osrmManeuver(st.maneuver || {});
        steps.push({
          path: ((st.geometry && st.geometry.coordinates) || []).map(([lng, lat]) => ({ lat, lng })),
          maneuver,
          instruction: osrmInstruction(st, maneuver),
        });
      }
    }
    const overview = ((r.geometry && r.geometry.coordinates) || []).map(([lng, lat]) => ({ lat, lng }));
    const route = joinSteps(steps, overview, r.duration || null);
    route.distance = r.distance || null;
    return route;
  }

  // opts.via: stops to pass through on the way, in order.
  async function routeOsrm(origin, destination, opts = {}) {
    const coords = [origin, ...(opts.via || []), destination].map(p => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
    // FOSSGIS has hints disabled and asks clients not to request them.
    const base = 'overview=full&geometries=geojson&steps=true&generate_hints=false';
    const queries = opts.avoidHighways ? [`${base}&exclude=motorway`, base] : [base];
    let lastError = null;
    for (const host of OSRM_HOSTS) {
      for (const qs of queries) {
        try {
          return parseOsrm(await fetchJSON(`${host}${coords}?${qs}`, {}, 15000));
        } catch (err) {
          lastError = err;
          if (err.message === 'NO_ROUTE') break;
        }
      }
    }
    throw lastError || new Error('Routing failed');
  }

  // ── Road features (Overpass) ──────────────────────────────

  function hazardKind(tags) {
    if (!tags) return null;
    if (tags.highway === 'traffic_signals') return 'lights';
    if (tags.highway === 'stop') return 'stop';
    if (tags.highway === 'speed_camera') return 'camera';
    if (tags.railway === 'level_crossing') return 'railway';
    if (/^(bump|hump|table|cushion|yes)$/.test(tags.traffic_calming || '')) return 'bump';
    return null;
  }

  // Speed cameras are often mapped beside the road rather than on it, so they
  // get a wider search radius.
  function overpassQuery(points, radius) {
    const poly = points.map(p => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`).join(',');
    const near = `(around:${radius},${poly})`;
    return `[out:json][timeout:25];
(
  node${near}["highway"~"^(traffic_signals|stop)$"];
  node(around:${Math.max(radius, 30)},${poly})["highway"="speed_camera"];
  node${near}["railway"="level_crossing"];
  node${near}["traffic_calming"~"^(bump|hump|table|cushion|yes)$"];
);
out body;
way${near}["highway"]["maxspeed"];
out body geom;`;
  }

  // Overpass JSON → {hazards: [{lat, lng, kind}], limitWays: [{maxspeed, geometry}]}
  function parseOverpass(json) {
    const hazards = [];
    const limitWays = [];
    for (const el of (json && json.elements) || []) {
      if (el.type === 'node') {
        const kind = hazardKind(el.tags);
        if (kind && Number.isFinite(el.lat)) hazards.push({ lat: el.lat, lng: el.lon, kind, id: el.id });
      } else if (el.type === 'way' && el.tags && el.tags.maxspeed && Array.isArray(el.geometry)) {
        limitWays.push({ maxspeed: el.tags.maxspeed, geometry: el.geometry.map(g => ({ lat: g.lat, lng: g.lon })), id: el.id });
      }
    }
    return { hazards, limitWays };
  }

  // Points every `spacing` metres along the stage, in chunks short enough for one query.
  function corridorChunks(samples, spacing = 40, perChunk = 300, maxChunks = 8) {
    const pts = [];
    let next = 0;
    for (const p of samples) {
      if (p.s >= next) {
        pts.push(p);
        next = p.s + spacing;
      }
    }
    const last = samples[samples.length - 1];
    if (pts[pts.length - 1] !== last) pts.push(last);
    const chunks = [];
    for (let i = 0; i < pts.length - 1 && chunks.length < maxChunks; i += perChunk - 1) chunks.push(pts.slice(i, i + perChunk));
    return chunks;
  }

  // Road features near the route, loaded two chunks at a time (public Overpass
  // servers allow about two parallel requests). Stops at `timeoutMs` and
  // resolves with whatever loaded; never rejects.
  async function roadFeatures(samples, opts = {}) {
    const deadline = Date.now() + (opts.timeoutMs || 25000);
    const hazards = new Map();
    const ways = new Map();
    const chunks = corridorChunks(samples);
    let loaded = 0;

    async function load(chunk) {
      const body = `data=${encodeURIComponent(overpassQuery(chunk, opts.radius || 12))}`;
      for (const host of OVERPASS_HOSTS) {
        const left = deadline - Date.now();
        if (left < 1000) return;
        try {
          const json = await fetchJSON(host, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body,
          }, Math.min(20000, left));
          const found = parseOverpass(json);
          found.hazards.forEach(h => hazards.set(h.id, h));
          found.limitWays.forEach(w => ways.set(w.id, w));
          loaded++;
          return;
        } catch (e) { /* try the next server */ }
      }
    }

    let next = 0;
    const worker = async () => {
      while (next < chunks.length && Date.now() < deadline) await load(chunks[next++]);
    };
    await Promise.all([worker(), worker()]);
    return {
      ok: loaded === chunks.length,
      partial: loaded > 0 && loaded < chunks.length,
      hazards: [...hazards.values()],
      limitWays: [...ways.values()],
    };
  }

  // ── Links to other apps ───────────────────────────────────

  // Shown wherever the app uses these services.
  const ATTRIBUTION = 'Map data © OpenStreetMap contributors (ODbL) · Routing: OSRM / FOSSGIS · Search: Photon · Features: Overpass API';

  const wazeLink = dest => `https://waze.com/ul?ll=${dest.lat.toFixed(6)},${dest.lng.toFixed(6)}&navigate=yes`;

  return {
    joinSteps,
    parsePhoton,
    parseNominatim,
    searchPlaces,
    osrmManeuver,
    parseOsrm,
    routeOsrm,
    hazardKind,
    overpassQuery,
    parseOverpass,
    corridorChunks,
    roadFeatures,
    wazeLink,
    ATTRIBUTION,
  };
});
