/*
 * Turn-by-turn guidance, the way phone navigation apps do it: the next
 * maneuver with its street and distance, the one after it, spoken prompts at
 * roughly half a mile / 500 ft / at the turn, and the road you're on.
 *
 * Works from stage.steps (see pacenotes.js). Pure JavaScript: in the browser
 * it is window.Guidance, in Node require('./guidance.js').
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Guidance = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SKIP = /^(DEPART|STRAIGHT|NAME_CHANGE|MANEUVER_UNSPECIFIED)$/;

  function ordinal(n) {
    const words = ['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth'];
    return words[n] || `${n}th`;
  }

  // Street-name abbreviations, spelled out so the voice says "Road", not "R D".
  const ABBR = {
    St: 'Street', Rd: 'Road', Ave: 'Avenue', Av: 'Avenue', Blvd: 'Boulevard', Dr: 'Drive', Ln: 'Lane',
    Ct: 'Court', Pl: 'Place', Hwy: 'Highway', Pkwy: 'Parkway', Expy: 'Expressway', Tpke: 'Turnpike',
    Fwy: 'Freeway', Cir: 'Circle', Ter: 'Terrace', Trl: 'Trail', Sq: 'Square', Mt: 'Mount', Ft: 'Fort',
    N: 'North', S: 'South', E: 'East', W: 'West', NE: 'Northeast', NW: 'Northwest', SE: 'Southeast', SW: 'Southwest',
  };

  function speakable(name) {
    return String(name || '')
      .replace(/^St\.? (?=[A-Z])/, 'Saint ')
      .replace(/\b(St|Rd|Ave?|Av|Blvd|Dr|Ln|Ct|Pl|Hwy|Pkwy|Expy|Tpke|Fwy|Cir|Ter|Trl|Sq|Mt|Ft|NE|NW|SE|SW|N|S|E|W)\b\.?/g, w => ABBR[w.replace('.', '')] || w);
  }

  // The maneuvers to guide through, in order, ending with the arrival.
  function maneuvers(stage, destination) {
    const list = (stage.steps || [])
      .filter(st => st.maneuver && !SKIP.test(st.maneuver))
      .map(st => ({ s: st.s, maneuver: st.maneuver, dir: st.dir, street: st.street, exit: st.exit, lanes: st.lanes, ramp: st.ramp }));
    list.push({ s: stage.length, maneuver: 'ARRIVE', street: destination || null });
    return list;
  }

  function action(m) {
    const side = m.dir === 'L' ? 'left' : 'right';
    const kind = m.maneuver;
    if (kind === 'ARRIVE') return 'Arrive';
    if (/^TURN_SLIGHT_/.test(kind)) return `Slight ${side}`;
    if (/^TURN_SHARP_/.test(kind)) return `Sharp ${side}`;
    if (/^TURN_/.test(kind)) return `Turn ${side}`;
    if (/^UTURN/.test(kind)) return 'Make a U-turn';
    if (/^(FORK|KEEP)_/.test(kind)) return `Keep ${side}`;
    if (/^RAMP_/.test(kind)) return m.ramp === 'off' ? `Take the exit on the ${side}` : `Take the ramp on the ${side}`;
    if (/^ROUNDABOUT/.test(kind)) return m.exit ? `At the roundabout, take the ${ordinal(m.exit)} exit` : 'Enter the roundabout';
    if (kind === 'MERGE') return 'Merge';
    if (/^FERRY/.test(kind)) return 'Take the ferry';
    return 'Continue';
  }

  // "Turn right onto Main St" (screen) / "Turn right onto Main Street" (voice).
  function instruction(m, spoken) {
    const street = m.street ? (spoken ? speakable(m.street) : m.street) : '';
    if (m.maneuver === 'ARRIVE') {
      const place = street.split(',')[0];   // "Quarry Lookout, Stowe, VT" → "Quarry Lookout"
      if (spoken) return place ? `Your destination, ${place}, is ahead` : 'Your destination is ahead';
      return place ? `Arrive at ${place}` : 'Arrive at destination';
    }
    return street ? `${action(m)} onto ${street}` : action(m);
  }

  const lowerFirst = t => t.charAt(0).toLowerCase() + t.slice(1);

  // For the banner: {value: "0.3", unit: "mi"} or {value: "450", unit: "ft"}.
  function displayDistance(m, units) {
    m = Math.max(0, m);
    if (units === 'mph') {
      const mi = m / 1609.344;
      if (mi < 0.1) return { value: String(Math.max(10, Math.round((m * 3.28084) / 10) * 10)), unit: 'ft' };
      return { value: mi < 10 ? mi.toFixed(1) : String(Math.round(mi)), unit: 'mi' };
    }
    if (m < 1000) return { value: String(Math.max(10, Math.round(m / 10) * 10)), unit: 'm' };
    const km = m / 1000;
    return { value: km < 10 ? km.toFixed(1) : String(Math.round(km)), unit: 'km' };
  }

  // For the voice: "500 feet", "a quarter mile", "half a mile", "2 miles", "300 meters".
  function spokenDistance(m, units) {
    if (units === 'mph') {
      const mi = m / 1609.344;
      if (mi < 0.2) return `${Math.max(100, Math.round((m * 3.28084) / 100) * 100).toLocaleString('en-US')} feet`;
      if (mi < 0.36) return 'a quarter mile';
      if (mi < 0.62) return 'half a mile';
      if (mi < 0.87) return 'three quarters of a mile';
      if (mi < 1.25) return '1 mile';
      return `${mi < 10 ? Math.round(mi * 2) / 2 : Math.round(mi)} miles`;
    }
    if (m < 950) return `${Math.max(50, Math.round(m / 50) * 50)} meters`;
    const km = m / 1000;
    return km < 1.25 ? '1 kilometer' : `${km < 10 ? Math.round(km * 2) / 2 : Math.round(km)} kilometers`;
  }

  // Road being driven at distance s along the stage.
  function roadAt(stage, s) {
    let name = '';
    for (const st of stage.steps || []) {
      if (st.s > s + 5) break;
      if (st.name) name = st.name;
    }
    return name;
  }

  // Index of the next maneuver at or ahead of s (a maneuver counts as done 15 m after it).
  function nextIndex(list, s, from = 0) {
    let i = from;
    while (i < list.length - 1 && list[i].s < s - 15) i++;
    return i;
  }

  /*
   * Decides when to speak each maneuver: "far" (~40 s ahead, at least ~500 m),
   * "near" (~11 s ahead) and "now" (~3 s ahead). Each fires at most once, and
   * a closer prompt cancels the farther ones it overtakes.
   * opts.skipNow(maneuver) → true when something else already covers the
   * at-the-turn moment (e.g. a rally "Square right" call).
   */
  class Prompter {
    constructor(list, opts) {
      this.list = list;
      this.o = Object.assign({
        units: 'mph', farTime: 40, nearTime: 11, nowTime: 3.5,
        minFar: 500, minNear: 120, minNow: 30, skipNow: () => false,
      }, opts);
      this.i = 0;
      this.fired = new Map();
    }

    update(s, speed) {
      const o = this.o;
      this.i = nextIndex(this.list, s, this.i);
      const m = this.list[this.i];
      const d = m.s - s;
      const v = Math.max(speed || 0, 8);   // time thresholds assume at least ~18 mph
      const far = Math.max(o.minFar, v * o.farTime);
      const near = Math.max(o.minNear, v * o.nearTime);
      const now = Math.max(o.minNow, v * o.nowTime);
      const stage = d <= now ? 'now' : d <= near ? 'near' : d <= far ? 'far' : null;
      if (!stage) return [];

      const fired = this.fired.get(this.i) || new Set();
      this.fired.set(this.i, fired);
      if (fired.has(stage) || fired.has('now') || (stage === 'far' && fired.has('near'))) return [];
      fired.add(stage);

      if (m.maneuver === 'ARRIVE' && stage === 'now') return [];
      if (stage === 'now' && o.skipNow(m)) return [];
      // No "in half a mile" when the previous maneuver was only just before.
      const prev = this.i > 0 ? this.list[this.i - 1].s : -Infinity;
      if (stage === 'far' && m.s - prev < far + 150) return [];

      let text = instruction(m, true);
      if (stage !== 'now') text = `In ${spokenDistance(d, o.units)}, ${lowerFirst(text)}`;
      const after = this.list[this.i + 1];
      if (after && after.maneuver !== 'ARRIVE' && after.s - m.s < 150) text += `, then ${lowerFirst(action(after))}`;
      return [{ text, stage, index: this.i, s: m.s }];
    }
  }

  return { maneuvers, action, instruction, speakable, displayDistance, spokenDistance, roadAt, nextIndex, Prompter, ordinal };
});
