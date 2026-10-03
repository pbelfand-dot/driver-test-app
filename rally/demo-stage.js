/*
 * A made-up twisty road used by the "Demo stage" button (works without a
 * Google Maps key) and by the tests. Each corner's radius and angle are known,
 * so the pace notes generated from it can be checked against reality.
 *
 * The path is emitted the way Google returns routes: sparse points on
 * straights, a point every few metres through bends, rounded to 5 decimals.
 */
(function (root, factory) {
  const api = factory(root.RallyNotes || (typeof require === 'function' ? require('./pacenotes.js') : null));
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DemoStage = api;
})(typeof self !== 'undefined' ? self : this, function (RallyNotes) {
  'use strict';

  const START = { lat: 44.26012, lng: -72.57541 };
  const START_HEADING = 20;

  // straight: metres | turn: L/R with angle (deg) and radius (m)
  const LAYOUT = [
    { straight: 250 },
    { turn: 'R', angle: 60, radius: 120 },
    { straight: 90 },
    { turn: 'L', angle: 90, radius: 45 },
    { straight: 10 },
    { turn: 'R', angle: 70, radius: 30 },
    { straight: 420 },
    { turn: 'L', angle: 175, radius: 14 },
    { straight: 130 },
    { turn: 'R', angle: 40, radius: 130 },
    { turn: 'R', angle: 55, radius: 32 },
    { straight: 320 },
    { turn: 'L', angle: 30, radius: 220 },
    { straight: 160 },
    { turn: 'R', angle: 90, radius: 8, maneuver: 'TURN_RIGHT', instruction: 'Turn right onto Quarry Rd' },
    { straight: 220 },
    { turn: 'L', angle: 140, radius: 90 },
    { straight: 70 },
    { turn: 'R', angle: 65, radius: 55 },
    { straight: 30 },
    { turn: 'L', angle: 65, radius: 55 },
    { straight: 480 },
    { turn: 'R', angle: 60, radius: 28 },
    { turn: 'R', angle: 40, radius: 110 },
    { straight: 300 },
  ];

  const round5 = p => ({ lat: Math.round(p.lat * 1e5) / 1e5, lng: Math.round(p.lng * 1e5) / 1e5 });

  function build(layout = LAYOUT, start = START, startHeading = START_HEADING) {
    const { offset } = RallyNotes;
    const path = [round5(start)];
    const steps = [{ index: 0, maneuver: 'DEPART', instruction: 'Head north on Stage Rd' }];
    let p = start;
    let h = startHeading;

    for (const seg of layout) {
      if (seg.straight) {
        p = offset(p, h, seg.straight);
        path.push(round5(p));
        continue;
      }
      const sign = seg.turn === 'R' ? 1 : -1;
      const arc = seg.radius * seg.angle * Math.PI / 180;
      const n = Math.max(2, Math.ceil(arc / 6));
      const dA = seg.angle / n;
      const chord = 2 * seg.radius * Math.sin((dA * Math.PI / 180) / 2);
      for (let k = 0; k < n; k++) {
        if (seg.maneuver && k === Math.floor(n / 2)) {
          steps.push({ index: path.length - 1, maneuver: seg.maneuver, instruction: seg.instruction });
        }
        p = offset(p, h + sign * dA / 2, chord);
        h += sign * dA;
        path.push(round5(p));
      }
    }
    return { name: 'Demo Stage', path, steps, synthetic: true };
  }

  return { LAYOUT, build };
});
