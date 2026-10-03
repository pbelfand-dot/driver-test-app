// Run with: node --test rally/test/
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../pacenotes.js');
const P = require('../providers.js');
const DemoStage = require('../demo-stage.js');
const { osrmFromRoute, overpassFor } = require('./fixtures.js');

test('OSRM maneuvers map to the engine maneuver names', () => {
  const m = (type, modifier) => P.osrmManeuver({ type, modifier });
  assert.equal(m('depart'), 'DEPART');
  assert.equal(m('turn', 'left'), 'TURN_LEFT');
  assert.equal(m('turn', 'sharp right'), 'TURN_SHARP_RIGHT');
  assert.equal(m('turn', 'slight left'), 'TURN_SLIGHT_LEFT');
  assert.equal(m('end of road', 'right'), 'TURN_RIGHT');
  assert.equal(m('continue', 'uturn'), 'UTURN_LEFT');
  assert.equal(m('continue', 'slight right'), '');
  assert.equal(m('fork', 'slight left'), 'FORK_LEFT');
  assert.equal(m('off ramp', 'right'), 'RAMP_RIGHT');
  assert.equal(m('roundabout', 'right'), 'ROUNDABOUT_RIGHT');
  assert.equal(m('new name', 'straight'), '');
  assert.equal(m('arrive'), '');
});

test('an OSRM route gives the same pace notes as the road it describes', () => {
  const demo = DemoStage.build();
  const route = P.parseOsrm(osrmFromRoute(demo));
  const stage = R.buildStage(route);
  assert.deepEqual(stage.notes.map(n => n.code), R.buildStage(demo).notes.map(n => n.code));
  const sq = stage.notes.find(n => n.kind === 'square');
  assert.equal(sq.street, 'Quarry Rd');
  assert.ok(route.duration > 0);
});

test('OSRM errors are reported', () => {
  assert.throws(() => P.parseOsrm({ code: 'NoRoute', routes: [] }), /NO_ROUTE/);
  assert.throws(() => P.parseOsrm({ code: 'InvalidQuery', message: 'Query string malformed' }), /malformed/);
});

test('roundabout exits come through from OSRM', () => {
  const route = P.parseOsrm({
    code: 'Ok',
    routes: [{
      duration: 60,
      geometry: { coordinates: [] },
      legs: [{ steps: [
        { name: 'A St', maneuver: { type: 'depart', location: [-73.2, 40.8] }, geometry: { coordinates: [[-73.2, 40.8], [-73.2, 40.802]] } },
        { name: 'Ocean Ave', maneuver: { type: 'roundabout', modifier: 'right', exit: 2, location: [-73.2, 40.802] }, geometry: { coordinates: [[-73.2, 40.802], [-73.2, 40.806]] } },
        { name: '', maneuver: { type: 'arrive', location: [-73.2, 40.806] }, geometry: { coordinates: [[-73.2, 40.806], [-73.2, 40.806]] } },
      ] }],
    }],
  });
  const stage = R.buildStage(route);
  assert.deepEqual(stage.notes.map(n => n.text), ['Roundabout, exit 2', 'Finish']);
});

test('road features land on the route; side-street signs and cross streets do not', () => {
  const demo = DemoStage.build();
  const base = R.buildStage(demo);
  const overpass = overpassFor(base);
  const { hazards, limitWays } = P.parseOverpass(overpass);
  const stage = R.buildStage(Object.assign({}, demo, { hazards, limitWays }));

  const texts = stage.notes.map(n => n.text);
  assert.ok(texts.includes('Speed camera'), texts.join(' | '));
  assert.ok(texts.includes('Rail crossing'), texts.join(' | '));
  assert.ok(texts.includes('Bump'), texts.join(' | '));
  // Lights at the junction turn merge into that note.
  assert.ok(texts.includes('Square right at lights'), texts.join(' | '));
  // The stop sign on a side street 18 m away is not ours.
  assert.ok(!texts.some(t => /stop sign/i.test(t)), texts.join(' | '));
  // Duplicate camera nodes 10 m apart count once.
  assert.equal(texts.filter(t => t === 'Speed camera').length, 1);

  // Speed limits: 30 mph for the first km, 45 mph after, unknown on the cross street.
  assert.equal(R.limitAt(stage, 200).value, 30);
  assert.equal(R.limitAt(stage, 200).unit, 'mph');
  assert.equal(R.limitAt(stage, 1500).value, 45);
  assert.equal(stage.limits.length, 2);
});

test('maxspeed tags parse to m/s', () => {
  assert.equal(R.parseMaxspeed('50').unit, 'km/h');
  assert.ok(Math.abs(R.parseMaxspeed('50').mps - 13.89) < 0.01);
  assert.ok(Math.abs(R.parseMaxspeed('30 mph').mps - 13.41) < 0.01);
  assert.equal(R.parseMaxspeed('none'), null);
  assert.equal(R.parseMaxspeed('signals'), null);
  assert.equal(R.parseMaxspeed('40;30').value, 40);
});

test('Photon and Nominatim results parse to labelled places', () => {
  const photon = P.parsePhoton({ features: [{
    geometry: { coordinates: [-73.5832, 40.6557] },
    properties: { housenumber: '68', street: 'South Ocean Avenue', city: 'Freeport', state: 'New York', country: 'United States' },
  }] });
  assert.deepEqual(photon, [{ lat: 40.6557, lng: -73.5832, label: '68 South Ocean Avenue, Freeport, New York' }]);
  const nom = P.parseNominatim([{ lat: '40.6557', lon: '-73.5832', display_name: 'Freeport, NY' }]);
  assert.deepEqual(nom, [{ lat: 40.6557, lng: -73.5832, label: 'Freeport, NY' }]);
});

test('the Overpass corridor follows the route in bounded chunks', () => {
  const stage = R.buildStage(DemoStage.build());
  const chunks = P.corridorChunks(stage.samples, 40, 30);
  assert.ok(chunks.length > 1);
  assert.deepEqual(chunks[0][29], chunks[1][0]);
  const q = P.overpassQuery(chunks[0], 12);
  assert.match(q, /node\(around:12,44\.26012,-72\.57541,/);
  assert.match(q, /node\(around:30,[^)]+\)\["highway"="speed_camera"\]/);
  assert.match(q, /way\(around:12,[^)]+\)\["highway"\]\["maxspeed"\];\nout body geom;/);
});

test('Waze link navigates to the destination', () => {
  assert.equal(P.wazeLink({ lat: 40.6557, lng: -73.5832 }), 'https://waze.com/ul?ll=40.655700,-73.583200&navigate=yes');
});
