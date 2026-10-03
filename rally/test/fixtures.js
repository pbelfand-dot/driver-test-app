// Builds realistic OSRM and Overpass responses around the demo stage, for
// tests and for the browser end-to-end checks.
const R = require('../pacenotes.js');

// Demo route → OSRM /route/v1 JSON (geojson geometry, steps).
function osrmFromRoute(route) {
  const cuts = route.steps.map(s => s.index);
  const steps = [];
  cuts.forEach((a, i) => {
    const b = i + 1 < cuts.length ? cuts[i + 1] : route.path.length - 1;
    const step = route.steps[i];
    const location = [route.path[a].lng, route.path[a].lat];
    steps.push({
      name: step.maneuver === 'TURN_RIGHT' ? 'Quarry Rd' : 'Stage Rd',
      distance: 100,
      maneuver: step.maneuver === 'DEPART'
        ? { type: 'depart', location, bearing_before: 0, bearing_after: 20 }
        : { type: 'turn', modifier: 'right', location },
      geometry: { type: 'LineString', coordinates: route.path.slice(a, b + 1).map(p => [p.lng, p.lat]) },
    });
  });
  const end = route.path[route.path.length - 1];
  steps.push({ name: 'Stage Rd', distance: 0, maneuver: { type: 'arrive', location: [end.lng, end.lat] }, geometry: { type: 'LineString', coordinates: [[end.lng, end.lat], [end.lng, end.lat]] } });
  return {
    code: 'Ok',
    routes: [{
      distance: 3457,
      duration: 245.3,
      geometry: { type: 'LineString', coordinates: route.path.map(p => [p.lng, p.lat]) },
      legs: [{ steps }],
    }],
    waypoints: [],
  };
}

// Overpass JSON with features placed at known spots along a built stage.
function overpassFor(stage) {
  const S = stage.samples;
  const at = s => R.pointAt(S, s);
  const side = (s, metres) => R.offset(at(s), R.headingAt(S, s) + 90, metres);
  const square = stage.notes.find(n => n.kind === 'square');
  let id = 1;
  const node = (p, tags) => ({ type: 'node', id: id++, lat: p.lat, lon: p.lng, tags });
  const wayAlong = (from, to, maxspeed, offset = 1.5) => {
    const geometry = [];
    for (let s = from; s <= to; s += 60) {
      const p = R.offset(at(s), R.headingAt(S, s) + 90, offset);
      geometry.push({ lat: p.lat, lon: p.lng });
    }
    return { type: 'way', id: id++, tags: { highway: 'secondary', maxspeed }, geometry, nodes: geometry.map((_, i) => 1000 + i) };
  };
  return {
    version: 0.6,
    elements: [
      node(at(square.apex - 5), { highway: 'traffic_signals' }),
      // Cameras are often mapped on a pole beside the road.
      node(side(700, 14), { highway: 'speed_camera' }),
      node(side(710, -12), { highway: 'speed_camera' }),
      node(at(1500), { railway: 'level_crossing' }),
      node(at(2300), { traffic_calming: 'hump' }),
      node(side(2000, 18), { highway: 'stop' }),
      node(at(2600), { highway: 'crossing' }),
      wayAlong(0, 1000, '30 mph'),
      wayAlong(1000, S[S.length - 1].s, '45 mph'),
      // A cross street touching the route at one point.
      { type: 'way', id: id++, tags: { highway: 'residential', maxspeed: '25 mph' }, geometry: [
        { lat: at(1200).lat, lon: at(1200).lng },
        { lat: side(1200, 80).lat, lon: side(1200, 80).lng },
      ] },
    ],
  };
}

module.exports = { osrmFromRoute, overpassFor };
