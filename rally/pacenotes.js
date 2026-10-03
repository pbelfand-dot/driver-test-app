/*
 * Rally pacenote engine.
 *
 * Turns a driving route (a list of lat/lng points plus the optional
 * turn-by-turn maneuvers Google returns) into rally-style pace notes such as
 * "4 left, 100, 3 right tightens 2", and tracks a car along the route so the
 * notes can be called out at the right moment.
 *
 * Severity scale (the common "1–6" system): 1 = slowest/tightest corner,
 * 6 = fastest. "Square" is a ~90° junction-type corner, "Hairpin" a ~180° one.
 * Grades come from the radius of the line a car can drive through the corner
 * while staying in its lane, not from a recommended speed.
 *
 * Pure JavaScript with no dependencies: in the browser it is exposed as
 * window.RallyNotes, in Node it is require('./pacenotes.js').
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RallyNotes = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const EARTH_R = 6371008.8;
  const RAD = Math.PI / 180;
  const DEG_PER_RAD = 180 / Math.PI;

  const DEFAULTS = {
    step: 5,               // resample spacing along the route (m)
    detectWindow: 45,      // curvature smoothing window used to find corners (m)
    onRadius: 350,         // bends gentler than this radius are never called (m)
    mergeGap: 10,          // same-direction bends closer than this are one corner (m)
    minAngle: 15,          // direction changes smaller than this are ignored (deg)
    laneWidth: 1.5,        // sideways room the car has inside its lane (m)
    tightenRatio: 1.6,     // entry/exit radius ratio that counts as tightens/opens
    longAngle: 110,        // corners turning more than this are "long" (deg)
    cautionStraight: 200,  // straight length before a slow corner that earns "caution" (m)
    linkGap: 100,          // notes closer than this are read out together (m)
    maxNotesPerCall: 3,
    maxCalledGap: 1000,    // longer straights are not announced as a distance (m)
    junctionSnap: 35,      // match Google maneuvers to geometric corners within (m)
    hazardSnap: 10,        // road features (lights, signs…) must be this close to the route (m)
    cameraSnap: 25,        // speed cameras are often mapped beside the road (m)
    limitSnap: 10,         // speed-limit road segments must run this close to the route (m)
  };

  // Upper bound of the driving-line radius (m) for grades 1..6.
  const GRADE_LIMITS = [25, 45, 75, 120, 200, 350];

  const NICE_DISTANCES = [
    30, 40, 50, 60, 70, 80, 100, 120, 150, 200, 250, 300, 350,
    400, 450, 500, 600, 700, 800, 900, 1000,
  ];

  // ── Geometry ──────────────────────────────────────────────

  function haversine(a, b) {
    const dLat = (b.lat - a.lat) * RAD;
    const dLng = (b.lng - a.lng) * RAD;
    const h = Math.sin(dLat / 2) ** 2 +
      Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLng / 2) ** 2;
    return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  // Initial compass bearing from a to b, degrees clockwise from north.
  function bearing(a, b) {
    const p1 = a.lat * RAD;
    const p2 = b.lat * RAD;
    const dl = (b.lng - a.lng) * RAD;
    const y = Math.sin(dl) * Math.cos(p2);
    const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    return (Math.atan2(y, x) * DEG_PER_RAD + 360) % 360;
  }

  function wrap180(d) {
    return ((((d + 180) % 360) + 360) % 360) - 180;
  }

  // Point reached by travelling `dist` metres from p on compass bearing `brg`.
  function offset(p, brg, dist) {
    const d = dist / EARTH_R;
    const t = brg * RAD;
    const p1 = p.lat * RAD;
    const l1 = p.lng * RAD;
    const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(t));
    const l2 = l1 + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(p1),
      Math.cos(d) - Math.sin(p1) * Math.sin(p2));
    return { lat: p2 * DEG_PER_RAD, lng: ((l2 * DEG_PER_RAD + 540) % 360) - 180 };
  }

  // Google encoded polyline → [{lat, lng}].
  function decodePolyline(str, precision = 5) {
    const factor = 10 ** precision;
    const out = [];
    let i = 0, lat = 0, lng = 0;
    while (i < str.length) {
      for (const which of [0, 1]) {
        let shift = 0, result = 0, byte;
        do {
          byte = str.charCodeAt(i++) - 63;
          result |= (byte & 0x1f) << shift;
          shift += 5;
        } while (byte >= 0x20);
        const delta = result & 1 ? ~(result >> 1) : result >> 1;
        if (which === 0) lat += delta; else lng += delta;
      }
      out.push({ lat: lat / factor, lng: lng / factor });
    }
    return out;
  }

  function toLatLng(p) {
    if (typeof p.lat === 'function') return { lat: p.lat(), lng: p.lng() };
    if (p.latitude !== undefined) return { lat: +p.latitude, lng: +p.longitude };
    return { lat: +p.lat, lng: +p.lng };
  }

  // Evenly spaced points along a path: [{lat, lng, s}] where s is metres from the start.
  function resample(path, step) {
    const pts = [];
    for (const raw of path) {
      const p = toLatLng(raw);
      const last = pts[pts.length - 1];
      if (!last || haversine(last, p) > 0.05) pts.push(p);
    }
    if (pts.length < 2) return { samples: pts.map(p => ({ ...p, s: 0 })), length: 0 };

    const samples = [{ lat: pts[0].lat, lng: pts[0].lng, s: 0 }];
    let carry = 0;
    let total = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const seg = haversine(a, b);
      let pos = step - carry;
      while (pos <= seg) {
        const t = pos / seg;
        samples.push({ lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t, s: total + pos });
        pos += step;
      }
      carry = seg - (pos - step);
      total += seg;
    }
    const end = pts[pts.length - 1];
    if (total - samples[samples.length - 1].s > step * 0.25) samples.push({ ...end, s: total });
    return { samples, length: total };
  }

  // Index of the last sample at or before distance s.
  function indexAt(samples, s) {
    let lo = 0, hi = samples.length - 1;
    if (s <= 0) return 0;
    if (s >= samples[hi].s) return hi;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (samples[mid].s <= s) lo = mid; else hi = mid;
    }
    return lo;
  }

  function pointAt(samples, s) {
    const i = indexAt(samples, s);
    const a = samples[i];
    const b = samples[Math.min(i + 1, samples.length - 1)];
    const span = b.s - a.s;
    const t = span > 0 ? Math.min(1, Math.max(0, (s - a.s) / span)) : 0;
    return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t, s };
  }

  // Direction of travel at distance s, smoothed over ±span metres.
  function headingAt(samples, s, span = 10) {
    const last = samples[samples.length - 1].s;
    const a = pointAt(samples, Math.max(0, Math.min(s - span, last - 2 * span)));
    const b = pointAt(samples, Math.min(last, Math.max(s + span, 2 * span)));
    return bearing(a, b);
  }

  // Light Gaussian blur of the sample positions (sigma = one step) so that
  // map-data jitter on straight roads doesn't read as tiny corners.
  function smoothPositions(samples) {
    const w = [0.135, 0.607, 1, 0.607, 0.135];
    const n = samples.length;
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      let lat = 0, lng = 0, sum = 0;
      for (let k = -2; k <= 2; k++) {
        const j = i + k;
        if (j < 0 || j >= n) continue;
        lat += samples[j].lat * w[k + 2];
        lng += samples[j].lng * w[k + 2];
        sum += w[k + 2];
      }
      out[i] = { lat: lat / sum, lng: lng / sum };
    }
    return out;
  }

  // Turn at each sample: dh[i] = change of heading (deg, + = right) between
  // the segment arriving at sample i and the one leaving it.
  function headingChanges(samples) {
    const pts = smoothPositions(samples);
    const n = pts.length;
    const dh = new Float64Array(n);
    let prev = null;
    for (let i = 0; i < n - 1; i++) {
      const h = bearing(pts[i], pts[i + 1]);
      if (prev !== null) dh[i] = wrap180(h - prev);
      prev = h;
    }
    return dh;
  }

  // Smoothed curvature (deg per metre) at every sample, averaged over ±halfWindow samples.
  function smoothedCurvature(dh, halfWindow, step) {
    const n = dh.length;
    const pre = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + dh[i];
    const k = new Float64Array(n);
    const span = (2 * halfWindow + 1) * step;
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - halfWindow);
      const b = Math.min(n - 1, i + halfWindow);
      k[i] = (pre[b + 1] - pre[a]) / span;
    }
    return k;
  }

  // ── Corner detection ──────────────────────────────────────

  function detectCorners(samples, dh, o) {
    const n = samples.length;
    const w = Math.max(1, Math.round(o.detectWindow / o.step / 2));
    const k = smoothedCurvature(dh, w, o.step);
    const kOn = DEG_PER_RAD / o.onRadius;
    const maxGap = Math.round(o.mergeGap / o.step);

    const groups = [];
    let g = null;
    for (let i = 1; i < n - 1; i++) {
      const sign = k[i] >= kOn ? 1 : k[i] <= -kOn ? -1 : 0;
      if (!sign) continue;
      if (g && g.sign === sign && i - g.b <= maxGap + 1) g.b = i;
      else groups.push(g = { sign, a: i, b: i });
    }

    // Smoothing widens or narrows the active zone, so grow each group by the
    // window size without crossing into its neighbours, then measure the raw turn.
    const corners = [];
    groups.forEach((grp, gi) => {
      const prevEnd = gi > 0 ? groups[gi - 1].b : 0;
      const nextStart = gi < groups.length - 1 ? groups[gi + 1].a : n - 1;
      const a = Math.max(grp.a - w, prevEnd + 1, 1);
      const b = Math.min(grp.b + w, nextStart - 1, n - 2);
      const c = measureCorner(samples, dh, a, b, grp.sign, o);
      if (c) corners.push(c);
    });
    return corners;
  }

  function measureCorner(samples, dh, a, b, sign, o) {
    let total = 0;
    for (let i = a; i <= b; i++) total += dh[i] * sign;
    if (total < o.minAngle) return null;

    // Distance along the route at which `frac` of the corner's turn is done.
    // Each sample's turn is treated as spread evenly over one step.
    const at = frac => {
      const target = frac * total;
      let cum = 0;
      for (let i = a; i <= b; i++) {
        const t = dh[i] * sign;
        if (t > 0 && cum + t >= target) return samples[i].s - o.step / 2 + ((target - cum) / t) * o.step;
        cum += t;
      }
      return samples[b].s;
    };
    const s05 = at(0.05), s10 = at(0.1), s50 = at(0.5), s90 = at(0.9), s95 = at(0.95);
    const rad = total * RAD;
    const minLen = o.step * 0.25;
    return {
      dir: sign > 0 ? 'R' : 'L',
      angle: total,
      start: s05,
      apex: s50,
      end: s95,
      radius: Math.max(minLen, s90 - s10) / (0.8 * rad),
      entryRadius: Math.max(minLen, s50 - s10) / (0.4 * rad),
      exitRadius: Math.max(minLen, s90 - s50) / (0.4 * rad),
    };
  }

  // Radius of the widest arc that fits through a corner of radius r turning
  // `angle` degrees, given `room` metres of sideways space (outside → apex → outside).
  function lineRadius(r, angle, room) {
    const half = Math.min(angle, 180) * RAD / 2;
    return r + room / (1 - Math.cos(half));
  }

  function gradeFor(lineR) {
    for (let i = 0; i < GRADE_LIMITS.length; i++) if (lineR < GRADE_LIMITS[i]) return i + 1;
    return null;
  }

  // Decide what kind of note a measured corner is. Returns null for bends too
  // gentle to call.
  function classify(c, o) {
    const note = Object.assign({ type: 'corner', mods: [] }, c);
    const atJunction = c.junction && /^TURN_(LEFT|RIGHT)$/.test(c.junction.maneuver);

    if (c.angle >= 140 && c.radius <= 35) { note.kind = 'hairpin'; return note; }
    if (atJunction ? c.angle >= 55 && c.angle <= 135 && c.radius <= 35
      : c.angle >= 65 && c.angle <= 125 && c.radius <= 22) {
      note.kind = 'square';
      return note;
    }

    const room = o.laneWidth;
    const ratio = c.entryRadius / c.exitRadius;
    note.kind = 'corner';
    if (ratio >= o.tightenRatio) {
      note.grade = gradeFor(lineRadius(c.entryRadius, c.angle, room)) || 6;
      const tight = gradeFor(lineRadius(c.exitRadius, c.angle, room));
      note.mods.push('tightens');
      if (tight && tight < note.grade) note.tightTo = tight;
    } else if (ratio <= 1 / o.tightenRatio) {
      note.grade = gradeFor(lineRadius(c.entryRadius, c.angle, room));
      if (note.grade) note.mods.push('opens');
    } else {
      note.grade = gradeFor(lineRadius(c.radius, c.angle, room));
    }
    if (!note.grade) return c.junction ? Object.assign(note, { kind: 'keep', mods: [] }) : null;
    if (c.angle >= o.longAngle || (c.end - c.start >= 160 && c.angle >= 40)) note.mods.unshift('long');
    return note;
  }

  // ── Google maneuvers ──────────────────────────────────────

  // Accepts Routes API enums (TURN_LEFT) and legacy Directions strings (turn-left).
  function normalizeManeuver(m) {
    return String(m || '').trim().toUpperCase().replace(/-/g, '_');
  }

  function maneuverDir(m) {
    if (/LEFT$/.test(m)) return 'L';
    if (/RIGHT$/.test(m)) return 'R';
    return null;
  }

  function stripHtml(s) {
    return String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function parseStreet(instruction) {
    const m = /\bonto ([^.,]+?)(?:\s+(?:Destination|Pass by|Toll road|Restricted usage).*)?$/i.exec(stripHtml(instruction));
    return m ? m[1].trim() : null;
  }

  function parseExit(instruction) {
    const m = /\b(\d+)(?:st|nd|rd|th) exit\b/i.exec(stripHtml(instruction));
    if (m) return +m[1];
    const words = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth'];
    const w = /\b(first|second|third|fourth|fifth|sixth) exit\b/i.exec(stripHtml(instruction));
    return w ? words.indexOf(w[1].toLowerCase()) + 1 : null;
  }

  // Name of the road a step travels on: "Turn left onto Main St" / "Head north on Elm Rd".
  function roadName(instruction) {
    const onto = parseStreet(instruction);
    if (onto) return onto;
    const m = /\bon ([^.,]+?)(?:\s+(?:toward|for)\b.*)?$/i.exec(stripHtml(instruction));
    return m ? m[1].trim() : null;
  }

  // Every route step with its distance from the start:
  // [{s, maneuver, dir, instruction, street, name, exit, lanes, ramp}].
  function stepsAlong(steps, rawPath) {
    if (!steps || !steps.length) return [];
    let cum = null;
    return steps.map(st => {
      let s = st.s;
      if (s === undefined && st.index !== undefined) {
        if (!cum) {
          cum = [0];
          for (let i = 1; i < rawPath.length; i++) cum.push(cum[i - 1] + haversine(toLatLng(rawPath[i - 1]), toLatLng(rawPath[i])));
        }
        s = cum[Math.min(st.index, cum.length - 1)];
      }
      const maneuver = normalizeManeuver(st.maneuver);
      return {
        s: s || 0,
        maneuver,
        dir: maneuverDir(maneuver),
        instruction: stripHtml(st.instruction),
        street: parseStreet(st.instruction),
        name: st.name || roadName(st.instruction),
        exit: st.exit || parseExit(st.instruction),
        lanes: st.lanes || null,
        ramp: st.ramp || null,
      };
    });
  }

  // The steps that matter for pace notes (turns, forks, roundabouts…).
  function normalizeSteps(steps, rawPath) {
    return stepsAlong(steps, rawPath)
      .filter(st => st.maneuver && !/^(DEPART|STRAIGHT|NAME_CHANGE|MANEUVER_UNSPECIFIED)$/.test(st.maneuver));
  }

  function applyManeuvers(corners, steps, o) {
    const events = [];
    let kept = corners;

    for (const st of steps) {
      const m = st.maneuver;
      if (/^ROUNDABOUT/.test(m)) {
        // Geometry inside a roundabout is a wiggle of lefts and rights; replace it.
        kept = kept.filter(c => c.apex < st.s - 20 || c.apex > st.s + 80);
        events.push({ type: 'event', kind: 'roundabout', exit: parseExit(st.instruction), start: st.s, end: st.s + 40, apex: st.s, street: st.street });
        continue;
      }
      if (/^(FERRY|FERRY_TRAIN)$/.test(m)) {
        events.push({ type: 'event', kind: 'ferry', start: st.s, end: st.s, apex: st.s });
        continue;
      }
      if (m === 'MERGE') {
        events.push({ type: 'event', kind: 'merge', start: st.s, end: st.s, apex: st.s, street: st.street });
        continue;
      }
      if (!st.dir) continue;

      const isTurn = /^(TURN_(LEFT|RIGHT|SHARP_LEFT|SHARP_RIGHT)|UTURN_(LEFT|RIGHT))$/.test(m);
      const isSoft = /^(TURN_SLIGHT_|FORK_|KEEP_|RAMP_)/.test(m);
      if (!isTurn && !isSoft) continue;

      let best = null;
      for (const c of kept) {
        const d = Math.abs(c.apex - st.s);
        if (c.dir === st.dir && d <= o.junctionSnap && c.angle >= 25 && (!best || d < Math.abs(best.apex - st.s))) best = c;
      }

      if (isTurn) {
        if (best) {
          best.junction = st;
        } else {
          const angle = /^UTURN/.test(m) ? 180 : /SHARP/.test(m) ? 135 : 90;
          const radius = /^UTURN/.test(m) ? 6 : /SHARP/.test(m) ? 8 : 10;
          kept = kept.concat({ dir: st.dir, angle, start: st.s - 8, apex: st.s, end: st.s + 8, radius, entryRadius: radius, exitRadius: radius, junction: st, synthetic: true });
        }
      } else {
        // Forks, ramps and slight turns: tell the driver which way to go.
        const kind = /^RAMP_/.test(m) ? 'ramp' : 'keep';
        if (best && best.angle >= 45) {
          best.junction = st;
        } else {
          if (best) kept = kept.filter(c => c !== best);
          events.push({ type: 'event', kind, dir: st.dir, start: st.s, end: st.s, apex: st.s, street: st.street });
        }
      }
    }
    return { corners: kept, events };
  }

  // ── Text ──────────────────────────────────────────────────

  const HAZARD_WORDS = { lights: 'Lights', stop: 'Stop sign', camera: 'Speed camera', railway: 'Rail crossing', bump: 'Bump' };
  const HAZARD_CODES = { lights: 'LIGHTS', stop: 'STOP', camera: 'CAMERA', railway: 'RAIL', bump: 'BUMP' };

  function niceDistance(m) {
    let best = NICE_DISTANCES[0];
    for (const d of NICE_DISTANCES) if (Math.abs(d - m) < Math.abs(best - m)) best = d;
    return best;
  }

  // Corner start/end points sit slightly inside the bend, so measured gaps run
  // ~10 m longer than the straight between them.
  function linkWord(gap) {
    if (gap < 20) return 'into';
    if (gap < 45) return 'and';
    return String(niceDistance(gap));
  }

  function noteText(n) {
    const side = n.dir === 'L' ? 'left' : 'right';
    let t;
    switch (n.kind) {
      case 'hairpin': t = `Hairpin ${side}`; break;
      case 'square': t = `Square ${side}`; break;
      case 'corner':
        t = `${n.grade} ${side}`;
        for (const mod of n.mods) t += mod === 'tightens' && n.tightTo ? ` tightens ${n.tightTo}` : ` ${mod}`;
        break;
      case 'keep': t = `Keep ${side}`; break;
      case 'ramp': t = `Ramp ${side}`; break;
      case 'roundabout': t = n.exit ? `Roundabout, exit ${n.exit}` : 'Roundabout'; break;
      case 'merge': t = 'Merge'; break;
      case 'ferry': t = 'Ferry'; break;
      case 'finish': t = 'Finish'; break;
      default: t = HAZARD_WORDS[n.kind] || '';
    }
    if (n.at) t += ` at ${HAZARD_WORDS[n.at].toLowerCase()}`;
    return n.caution ? `Caution, ${t.charAt(0).toLowerCase()}${t.slice(1)}` : t;
  }

  // Short label for compact displays: "4L", "HP R", "SQ L", "KEEP L"…
  function noteCode(n) {
    const d = n.dir || '';
    switch (n.kind) {
      case 'corner': return `${n.grade}${d}${n.mods.includes('tightens') ? '-' : n.mods.includes('opens') ? '+' : ''}`;
      case 'hairpin': return `HP ${d}`;
      case 'square': return `SQ ${d}`;
      case 'keep': return `KEEP ${d}`;
      case 'ramp': return `RAMP ${d}`;
      case 'roundabout': return n.exit ? `RB ${n.exit}` : 'RB';
      case 'merge': return 'MERGE';
      case 'ferry': return 'FERRY';
      case 'finish': return 'FINISH';
      default: return HAZARD_CODES[n.kind] || '';
    }
  }

  function buildCalls(notes, o) {
    const calls = [];
    let i = 0;
    while (i < notes.length) {
      const first = notes[i];
      const group = [first];
      let text = first.text;
      let j = i;
      while (j + 1 < notes.length && group.length < o.maxNotesPerCall) {
        const gap = notes[j + 1].start - notes[j].end;
        if (gap > o.linkGap) break;
        const w = notes[j].link;
        text += (w === 'into' || w === 'and' ? ` ${w} ` : `, ${w}, `) + notes[j + 1].text.charAt(0).toLowerCase() + notes[j + 1].text.slice(1);
        group.push(notes[++j]);
      }
      const last = notes[j];
      if (last.link && last.link !== 'into' && last.link !== 'and' && j + 1 < notes.length) text += `, ${last.link}`;
      calls.push({ id: calls.length, start: first.start, end: last.end, notes: group, text });
      i = j + 1;
    }
    return calls;
  }

  // ── Road features from map data ───────────────────────────

  // Grid of route segments for fast "where is this point on the route" lookups.
  class RouteIndex {
    constructor(samples, cell = 100) {
      this.samples = samples;
      this.cell = cell;
      const o = samples[0];
      this.ky = EARTH_R * RAD;
      this.kx = this.ky * Math.cos(o.lat * RAD);
      this.o = o;
      this.grid = new Map();
      for (let i = 0; i < samples.length - 1; i++) {
        const [x, y] = this.xy(samples[i]);
        const key = `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
        if (!this.grid.has(key)) this.grid.set(key, []);
        this.grid.get(key).push(i);
      }
    }

    xy(p) {
      return [(p.lng - this.o.lng) * this.kx, (p.lat - this.o.lat) * this.ky];
    }

    // Nearest point on the route within maxD metres → {s, d} or null.
    nearest(p, maxD) {
      const [x, y] = this.xy(p);
      const cx = Math.floor(x / this.cell), cy = Math.floor(y / this.cell);
      const reach = Math.ceil(maxD / this.cell);
      let best = null;
      for (let gx = cx - 1 - reach; gx <= cx + 1 + reach; gx++) {
        for (let gy = cy - 1 - reach; gy <= cy + 1 + reach; gy++) {
          const list = this.grid.get(`${gx},${gy}`);
          if (!list) continue;
          for (const i of list) {
            const r = projectOnSegment(p, this.samples[i], this.samples[i + 1]);
            if (r.d <= maxD && (!best || r.d < best.d)) best = r;
          }
        }
      }
      return best;
    }
  }

  // OSM maxspeed tag → {value, unit, mps}; null for "none", "signals", etc.
  function parseMaxspeed(v) {
    if (v === undefined || v === null) return null;
    const m = /^(\d+(?:\.\d+)?)\s*(mph|km\/h|kmh|kph|knots)?$/i.exec(String(v).split(';')[0].trim());
    if (!m) return null;
    const n = +m[1];
    const unit = (m[2] || 'km/h').toLowerCase();
    if (unit === 'mph') return { value: n, unit: 'mph', mps: n * 0.44704 };
    if (unit === 'knots') return { value: n, unit: 'knots', mps: n * 0.514444 };
    return { value: n, unit: 'km/h', mps: n / 3.6 };
  }

  // hazards: [{lat, lng, kind}] → [{kind, s}] on the route, nearby duplicates merged.
  function placeHazards(index, hazards, o) {
    const placed = [];
    for (const h of hazards) {
      const hit = index.nearest(h, h.kind === 'camera' ? o.cameraSnap : o.hazardSnap);
      if (hit) placed.push({ kind: h.kind, s: hit.s });
    }
    placed.sort((a, b) => a.s - b.s);
    return placed.filter((h, i) => !placed.slice(0, i).some(p => p.kind === h.kind && h.s - p.s < 40));
  }

  // ways: [{maxspeed, geometry: [{lat, lng}]}] → sorted [{start, end, value, unit, mps}].
  // A way segment counts when both ends sit on the route and it runs along it
  // (cross streets touch the route at one point only).
  function placeLimits(index, ways, o) {
    const spans = [];
    for (const w of ways) {
      const limit = parseMaxspeed(w.maxspeed);
      const g = w.geometry || [];
      if (!limit || g.length < 2) continue;
      for (let k = 0; k < g.length - 1; k++) {
        const a = index.nearest(g[k], o.limitSnap);
        const b = a && index.nearest(g[k + 1], o.limitSnap);
        if (!a || !b) continue;
        const len = haversine(g[k], g[k + 1]);
        if (Math.abs(a.s - b.s) < 0.6 * len) continue;
        spans.push(Object.assign({ start: Math.min(a.s, b.s), end: Math.max(a.s, b.s) }, limit));
      }
    }
    spans.sort((a, b) => a.start - b.start);
    const merged = [];
    for (const sp of spans) {
      const last = merged[merged.length - 1];
      if (last && last.mps === sp.mps && sp.start - last.end < 40) last.end = Math.max(last.end, sp.end);
      else merged.push(Object.assign({}, sp));
    }
    return merged;
  }

  // Speed limit at distance s along the stage, or null when unknown.
  function limitAt(stage, s) {
    const L = stage.limits || [];
    let found = null;
    for (const sp of L) {
      if (sp.start > s + 5) break;
      if (s <= sp.end + 15) found = sp;
    }
    return found;
  }

  // Lights or a stop sign right at a junction turn become part of that note
  // ("Square left at lights"); everything else is a note of its own.
  function mergeHazards(notes, hazards) {
    const out = notes.slice();
    for (const h of hazards) {
      if (h.kind === 'lights' || h.kind === 'stop') {
        const turn = notes.find(n => n.type === 'corner' && n.junction && !n.at && h.s >= n.start - 35 && h.s <= n.apex + 10);
        if (turn) { turn.at = h.kind; continue; }
      }
      out.push({ type: 'event', kind: h.kind, start: h.s, end: h.s, apex: h.s });
    }
    return out;
  }

  // ── Stage ─────────────────────────────────────────────────

  /*
   * route = {
   *   path:  [{lat, lng}, ...]   detailed route geometry (LatLng objects work too)
   *   steps: [{s | index, maneuver, instruction}, ...]   optional Google steps;
   *          s = metres from start of the maneuver, or index = position in path
   * }
   */
  function buildStage(route, options) {
    const o = Object.assign({}, DEFAULTS, options);
    const { samples, length } = resample(route.path || [], o.step);
    if (samples.length < 3 || length < 20) throw new Error('Route is too short to build pace notes.');

    const dh = headingChanges(samples);
    const allSteps = stepsAlong(route.steps, route.path);
    const steps = normalizeSteps(route.steps, route.path);
    const raw = detectCorners(samples, dh, o);
    const { corners, events } = applyManeuvers(raw, steps, o);

    const index = new RouteIndex(samples);
    const hazards = placeHazards(index, route.hazards || [], o);
    const notes = mergeHazards(corners.map(c => classify(c, o)).filter(Boolean).concat(events), hazards);
    notes.sort((a, b) => a.start - b.start);
    notes.push({ type: 'event', kind: 'finish', start: length, end: length, apex: length });

    let prevEnd = 0;
    notes.forEach((n, i) => {
      n.id = i;
      if (n.junction && n.junction.street) n.street = n.junction.street;
      const straight = n.start - prevEnd;
      const slow = n.kind === 'hairpin' || (n.kind === 'square' && !n.junction) || (n.kind === 'corner' && n.grade <= 2);
      n.caution = slow && !n.junction && straight >= o.cautionStraight;
      prevEnd = Math.max(prevEnd, n.end);
    });
    notes.forEach((n, i) => {
      n.text = noteText(n);
      n.code = noteCode(n);
      const next = notes[i + 1];
      if (!next) { n.link = null; return; }
      const gap = Math.max(0, next.start - n.end);
      n.link = gap <= o.maxCalledGap ? linkWord(gap) : null;
    });

    const calls = buildCalls(notes, o);
    const cornersOnly = notes.filter(n => n.type === 'corner');
    const km = length / 1000;
    return {
      samples,
      length,
      notes,
      calls,
      limits: placeLimits(index, route.limitWays || [], o),
      steps: allSteps,
      stats: {
        corners: cornersOnly.length,
        perKm: km > 0 ? cornersOnly.length / km : 0,
        hairpins: cornersOnly.filter(n => n.kind === 'hairpin').length,
        squares: cornersOnly.filter(n => n.kind === 'square').length,
        hazards: hazards.length,
      },
    };
  }

  // ── Following the car ─────────────────────────────────────

  // Nearest point on segment a→b to p, in a local flat projection around a.
  function projectOnSegment(p, a, b) {
    const kx = Math.cos(a.lat * RAD) * EARTH_R * RAD;
    const ky = EARTH_R * RAD;
    const bx = (b.lng - a.lng) * kx, by = (b.lat - a.lat) * ky;
    const px = (p.lng - a.lng) * kx, py = (p.lat - a.lat) * ky;
    const len2 = bx * bx + by * by;
    const t = len2 > 0 ? Math.max(0, Math.min(1, (px * bx + py * by) / len2)) : 0;
    const dx = px - t * bx, dy = py - t * by;
    return { t, d: Math.sqrt(dx * dx + dy * dy), s: a.s + t * (b.s - a.s) };
  }

  // Speed from GPS fixes. Phones measure speed from the Doppler shift of the
  // satellite signals (coords.speed), which is far steadier than differencing
  // positions, so that is used whenever it is present. Otherwise speed comes
  // from how far the car moved over the last few seconds. Physically impossible
  // jumps are clamped, and GPS wander while parked reads as 0.
  class SpeedFilter {
    constructor(opts) {
      this.opts = Object.assign({
        maxAccel: 10,      // m/s² — no road car changes speed faster than ~1 g
        standstill: 0.6,   // below this (m/s, ~1.3 mph) show 0
        window: 4000,      // position history used when there is no Doppler speed (ms)
        maxAccuracy: 40,   // ignore positions worse than this for speed (m)
      }, opts);
      this.reset();
    }

    reset() {
      this.speed = 0;
      this.history = [];
      this.recent = [];
      this.lastT = null;
      this.source = null;
    }

    // fix = {lat, lng, speed? (m/s), accuracy? (m), timestamp? (ms)} → m/s
    update(fix) {
      const o = this.opts;
      const t = fix.timestamp !== undefined ? fix.timestamp : Date.now();
      const acc = fix.accuracy || 0;
      if (acc <= o.maxAccuracy) this.history.push({ lat: fix.lat, lng: fix.lng, t, acc });
      while (this.history.length > 2 && t - this.history[0].t > o.window) this.history.shift();

      let raw = null;
      if (Number.isFinite(fix.speed) && fix.speed >= 0) {
        raw = fix.speed;
        this.source = 'doppler';
      } else if (this.history.length >= 2) {
        const first = this.history[0];
        const last = this.history[this.history.length - 1];
        const dt = (last.t - first.t) / 1000;
        if (dt >= 0.5) {
          const moved = haversine(first, last);
          // Movement within the GPS error circle is wander, not driving.
          raw = moved <= Math.max(first.acc, last.acc, 5) && moved / dt < 2.5 ? 0 : moved / dt;
          this.source = 'position';
        }
      }

      if (raw !== null) {
        this.recent.push(raw);
        if (this.recent.length > 3) this.recent.shift();
        if (this.lastT === null) {
          this.speed = raw;
        } else {
          const dt = Math.max(0.05, (t - this.lastT) / 1000);
          const step = o.maxAccel * dt;
          // A jump no car could make is a glitch: use the median of the last 3 readings.
          if (Math.abs(raw - this.speed) > step && this.recent.length === 3) {
            raw = this.recent.slice().sort((a, b) => a - b)[1];
          }
          raw = Math.max(this.speed - step, Math.min(this.speed + step, raw));
          this.speed += (this.source === 'doppler' ? 0.7 : 0.4) * (raw - this.speed);
        }
        if (this.speed < o.standstill) this.speed = 0;
        this.lastT = t;
      }
      return this.speed;
    }
  }

  class Tracker {
    constructor(stage, opts) {
      this.stage = stage;
      this.opts = Object.assign({ offRouteDistance: 45, offRouteFixes: 3, lookAhead: 400 }, opts);
      this.reset();
    }

    reset() {
      this.idx = -1;
      this.s = 0;
      this.d = 0;
      this.speed = 0;
      this.offCount = 0;
      this.offRoute = false;
      this.speedFilter = new SpeedFilter();
    }

    search(p, from, to) {
      const S = this.stage.samples;
      let best = null;
      for (let i = Math.max(0, from); i < Math.min(S.length - 1, to); i++) {
        const r = projectOnSegment(p, S[i], S[i + 1]);
        if (!best || r.d < best.d) { best = r; best.i = i; }
      }
      return best;
    }

    // fix = {lat, lng, accuracy?, speed? (m/s), timestamp? (ms)}
    update(fix) {
      const S = this.stage.samples;
      const p = { lat: fix.lat, lng: fix.lng };
      let best;
      if (this.idx < 0) {
        best = this.search(p, 0, S.length);
      } else {
        const ahead = Math.ceil(this.opts.lookAhead / (S[1].s - S[0].s || 5));
        best = this.search(p, this.idx - 10, this.idx + ahead);
        if (best.d > 60) {
          const global = this.search(p, 0, S.length);
          if (global.d < best.d - 20) best = global;
        }
      }

      this.speed = this.speedFilter.update(fix);

      const acc = fix.accuracy || 0;
      const limit = Math.max(this.opts.offRouteDistance, acc * 1.5);
      if (best.d > limit && acc < 100) this.offCount++;
      else if (best.d <= limit) this.offCount = 0;
      this.offRoute = this.offCount >= this.opts.offRouteFixes;

      this.idx = best.i;
      this.s = best.s;
      this.d = best.d;
      return { s: this.s, d: this.d, speed: this.speed, offRoute: this.offRoute };
    }
  }

  // Decides when each call should be read out: a few seconds before the first
  // corner in it, earlier at higher speed.
  class CallScheduler {
    constructor(calls, opts) {
      this.calls = calls;
      this.opts = Object.assign({ leadTime: 5, leadBase: 25, minLead: 50, maxLead: 450 }, opts);
      this.next = 0;
    }

    leadDistance(speed) {
      const o = this.opts;
      return Math.min(o.maxLead, Math.max(o.minLead, o.leadBase + speed * o.leadTime));
    }

    // Returns the calls that are due now. Calls already driven past are dropped.
    update(s, speed) {
      const due = [];
      const lead = this.leadDistance(speed);
      while (this.next < this.calls.length && this.calls[this.next].start - s <= lead) {
        const c = this.calls[this.next++];
        if (c.start >= s - 10) due.push(c);
      }
      return due;
    }

    // Upcoming calls (for displays), not yet read.
    upcoming() {
      return this.calls.slice(this.next);
    }
  }

  // Drives a virtual car along the stage so everything can be tried at a desk.
  class Simulator {
    constructor(stage, opts) {
      const o = this.opts = Object.assign({ maxSpeed: 24, lateralAccel: 3, accel: 2, brake: 3.5, minSpeed: 3 }, opts);
      const S = stage.samples;
      const n = S.length;
      const step = n > 1 ? S[1].s - S[0].s : 5;
      const k = smoothedCurvature(headingChanges(S), Math.max(1, Math.round(15 / step)), step);
      const v = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const r = Math.abs(k[i]) > 1e-6 ? DEG_PER_RAD / Math.abs(k[i]) : Infinity;
        v[i] = Math.min(o.maxSpeed, Math.sqrt(o.lateralAccel * r));
      }
      v[0] = 0;
      v[n - 1] = 0;
      for (let i = n - 2; i >= 0; i--) v[i] = Math.min(v[i], Math.sqrt(v[i + 1] ** 2 + 2 * o.brake * (S[i + 1].s - S[i].s)));
      for (let i = 1; i < n; i++) v[i] = Math.min(v[i], Math.sqrt(v[i - 1] ** 2 + 2 * o.accel * (S[i].s - S[i - 1].s)));
      this.stage = stage;
      this.profile = v;
      this.s = 0;
      this.t = 0;
    }

    speedAt(s) {
      const S = this.stage.samples;
      const i = indexAt(S, s);
      const j = Math.min(i + 1, S.length - 1);
      const span = S[j].s - S[i].s;
      const t = span > 0 ? (s - S[i].s) / span : 0;
      return this.profile[i] + (this.profile[j] - this.profile[i]) * t;
    }

    get done() {
      return this.s >= this.stage.length - 0.5;
    }

    // Advance dt seconds; returns a GPS-like fix.
    step(dt) {
      const v = Math.max(this.opts.minSpeed, this.speedAt(this.s));
      this.s = Math.min(this.stage.length, this.s + v * dt);
      this.t += dt;
      const p = pointAt(this.stage.samples, this.s);
      return {
        lat: p.lat,
        lng: p.lng,
        speed: this.done ? 0 : this.speedAt(this.s),
        heading: headingAt(this.stage.samples, this.s),
        accuracy: 5,
        timestamp: this.t * 1000,
      };
    }
  }

  return {
    DEFAULTS,
    GRADE_LIMITS,
    buildStage,
    decodePolyline,
    haversine,
    bearing,
    offset,
    wrap180,
    resample,
    pointAt,
    headingAt,
    indexAt,
    lineRadius,
    gradeFor,
    niceDistance,
    linkWord,
    noteText,
    parseExit,
    parseStreet,
    parseMaxspeed,
    limitAt,
    RouteIndex,
    SpeedFilter,
    Tracker,
    CallScheduler,
    Simulator,
  };
});
