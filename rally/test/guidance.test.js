// Run with: node --test rally/test/
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../pacenotes.js');
const P = require('../providers.js');
const G = require('../guidance.js');
const DemoStage = require('../demo-stage.js');
const { osrmFromRoute } = require('./fixtures.js');

// A town drive: depart on Elm St, left onto Main St, right at a roundabout
// (2nd exit), fork right onto a ramp, arrive. Straight segments between.
function townRoute() {
  const start = { lat: 40.75, lng: -73.55 };
  const pts = [start];
  let p = start;
  const go = (brg, m) => { for (let d = 20; d <= m; d += 20) pts.push(R.offset(p, brg, d)); p = pts[pts.length - 1]; };
  go(0, 900);            // Elm St north
  const leftAt = pts.length - 1;
  go(270, 1400);         // Main St west
  const rbAt = pts.length - 1;
  go(270, 400);          // through the roundabout
  const forkAt = pts.length - 1;
  go(300, 1500);         // ramp
  const path = pts;
  return {
    path,
    steps: [
      { index: 0, maneuver: 'DEPART', instruction: 'Head north on Elm St', name: 'Elm St' },
      { index: leftAt, maneuver: 'TURN_LEFT', instruction: 'Turn left onto Main St', name: 'Main St',
        lanes: [{ indications: ['left'], valid: true }, { indications: ['straight'], valid: false }, { indications: ['straight', 'right'], valid: false }] },
      { index: rbAt, maneuver: 'ROUNDABOUT_RIGHT', instruction: 'At the roundabout, take the 2nd exit onto Main St', name: 'Main St', exit: 2 },
      { index: forkAt, maneuver: 'RAMP_RIGHT', instruction: 'Keep right onto NY-135 N', name: 'NY-135 N', ramp: 'on' },
    ],
  };
}

test('maneuvers come out in order with streets, exits and lanes, ending at the destination', () => {
  const stage = R.buildStage(townRoute());
  const list = G.maneuvers(stage, 'Hicksville Station, Hicksville, NY');
  assert.deepEqual(list.map(m => G.instruction(m)), [
    'Turn left onto Main St',
    'At the roundabout, take the second exit onto Main St',
    'Take the ramp on the right onto NY-135 N',
    'Arrive at Hicksville Station',
  ]);
  assert.equal(list[0].lanes.length, 3);
  assert.equal(G.instruction(list[3], true), 'Your destination, Hicksville Station, is ahead');
  assert.ok(Math.abs(list[0].s - 900) < 2);
});

test('the road you are on follows the steps', () => {
  const stage = R.buildStage(townRoute());
  assert.equal(G.roadAt(stage, 100), 'Elm St');
  assert.equal(G.roadAt(stage, 1500), 'Main St');
  assert.equal(G.roadAt(stage, 3000), 'NY-135 N');
});

test('distances read like a navigation app', () => {
  assert.deepEqual(G.displayDistance(137, 'mph'), { value: '450', unit: 'ft' });
  assert.deepEqual(G.displayDistance(500, 'mph'), { value: '0.3', unit: 'mi' });
  assert.deepEqual(G.displayDistance(640, 'kmh'), { value: '640', unit: 'm' });
  assert.deepEqual(G.displayDistance(2345, 'kmh'), { value: '2.3', unit: 'km' });
  assert.equal(G.spokenDistance(152, 'mph'), '500 feet');
  assert.equal(G.spokenDistance(310, 'mph'), '1,000 feet');
  assert.equal(G.spokenDistance(400, 'mph'), 'a quarter mile');
  assert.equal(G.spokenDistance(805, 'mph'), 'half a mile');
  assert.equal(G.spokenDistance(3300, 'mph'), '2 miles');
  assert.equal(G.spokenDistance(300, 'kmh'), '300 meters');
  assert.equal(G.spokenDistance(2600, 'kmh'), '2.5 kilometers');
});

test('street abbreviations are spoken in full', () => {
  assert.equal(G.speakable('S Ocean Ave'), 'South Ocean Avenue');
  assert.equal(G.speakable('Quarry Rd'), 'Quarry Road');
  assert.equal(G.speakable('St James Pl'), 'Saint James Place');
  assert.equal(G.speakable('Old Country Rd W'), 'Old Country Road West');
  assert.equal(G.speakable('Sunrise Hwy'), 'Sunrise Highway');
});

test('a drive gets far, near and at-the-turn prompts, each once and in order', () => {
  const stage = R.buildStage(townRoute());
  const list = G.maneuvers(stage, 'Hicksville Station');
  const prompter = new G.Prompter(list, { units: 'mph' });
  const spoken = [];
  for (let s = 0; s <= stage.length; s += 5) {
    for (const p of prompter.update(s, 15)) spoken.push(`${p.stage}@${Math.round(p.s - s)}: ${p.text}`);
  }
  const texts = spoken.map(t => t.replace(/^\w+@-?\d+: /, ''));
  assert.deepEqual(texts, [
    'In half a mile, turn left onto Main Street',
    'In 500 feet, turn left onto Main Street',
    'Turn left onto Main Street',
    'In half a mile, at the roundabout, take the second exit onto Main Street',
    'In 500 feet, at the roundabout, take the second exit onto Main Street',
    'At the roundabout, take the second exit onto Main Street',
    'In 500 feet, take the ramp on the right onto NY-135 North',
    'Take the ramp on the right onto NY-135 North',
    'In half a mile, your destination, Hicksville Station, is ahead',
    'In 500 feet, your destination, Hicksville Station, is ahead',
  ]);
  // The ramp is only 400 m after the roundabout: no "half a mile" warning for it.
  assert.ok(!texts.some(t => /^In (a quarter|half).*ramp/.test(t)));
});

test('the at-the-turn prompt can defer to a rally junction call', () => {
  const stage = R.buildStage(townRoute());
  const list = G.maneuvers(stage);
  const prompter = new G.Prompter(list, { skipNow: m => m.maneuver === 'TURN_LEFT' });
  const texts = [];
  for (let s = 0; s <= 1000; s += 5) for (const p of prompter.update(s, 15)) texts.push(p.text);
  assert.ok(texts.includes('In 500 feet, turn left onto Main Street'));
  assert.ok(!texts.includes('Turn left onto Main Street'));
});

test('jumping close to a turn (e.g. after a reroute) says only the nearest prompt', () => {
  const stage = R.buildStage(townRoute());
  const prompter = new G.Prompter(G.maneuvers(stage));
  // 120 m before the turn at 15 m/s: inside "near" (165 m), past "far".
  assert.deepEqual(prompter.update(780, 15).map(p => p.stage), ['near']);
  assert.deepEqual(prompter.update(860, 15).map(p => p.stage), ['now']);
  assert.deepEqual(prompter.update(870, 15), []);
});

test('close maneuvers are chained: "…, then turn left"', () => {
  const route = townRoute();
  route.steps.splice(2, 0, { s: 980, maneuver: 'TURN_RIGHT', instruction: 'Turn right onto Oak St', name: 'Oak St' });
  const stage = R.buildStage(route);
  const prompter = new G.Prompter(G.maneuvers(stage));
  const texts = [];
  for (let s = 0; s <= 1000; s += 5) for (const p of prompter.update(s, 15)) texts.push(p.text);
  assert.ok(texts.includes('Turn left onto Main Street, then turn right'), texts.join('\n'));
});

test('OSRM steps carry road names and lanes through to guidance', () => {
  const demo = DemoStage.build();
  const osrm = osrmFromRoute(demo);
  osrm.routes[0].legs[0].steps[1].intersections = [{ lanes: [{ indications: ['right'], valid: true }, { indications: ['straight'], valid: false }] }];
  const stage = R.buildStage(P.parseOsrm(osrm));
  const list = G.maneuvers(stage, 'Quarry Lookout');
  assert.equal(G.instruction(list[0]), 'Turn right onto Quarry Rd');
  assert.deepEqual(list[0].lanes.map(l => l.valid), [true, false]);
  assert.equal(G.roadAt(stage, 10), 'Stage Rd');
});
