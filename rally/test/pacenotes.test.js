// Run with: node --test rally/test/
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../pacenotes.js');
const DemoStage = require('../demo-stage.js');

const straightPath = (start, heading, metres, every = 20) => {
  const pts = [start];
  for (let d = every; d <= metres; d += every) pts.push(R.offset(start, heading, d));
  return pts;
};

test('decodes Google encoded polylines', () => {
  const pts = R.decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
  assert.deepEqual(pts, [
    { lat: 38.5, lng: -120.2 },
    { lat: 40.7, lng: -120.95 },
    { lat: 43.252, lng: -126.453 },
  ]);
});

test('resample spaces points evenly and keeps the route length', () => {
  const path = straightPath({ lat: 40.8, lng: -73.2 }, 90, 1000, 333);
  const { samples, length } = R.resample(path, 5);
  assert.ok(Math.abs(length - 999) < 1, `length ${length}`);
  for (let i = 1; i < samples.length - 1; i++) {
    assert.ok(Math.abs(samples[i].s - samples[i - 1].s - 5) < 1e-6);
  }
});

test('demo stage produces the expected pace notes', () => {
  const stage = R.buildStage(DemoStage.build());
  assert.deepEqual(stage.notes.map(n => n.code), [
    '5R', '3L', '2R', 'HP L', '4R-', '6L', 'SQ R', '4L', '3R', '3L', '2R+', 'FINISH',
  ]);
});

test('measured corner radius and angle match the real road', () => {
  const stage = R.buildStage(DemoStage.build());
  const corners = stage.notes.filter(n => n.type === 'corner');
  // Single-radius corners from DemoStage.LAYOUT, in order of appearance.
  const truth = [
    [0, 60, 120], [1, 90, 45], [2, 70, 30], [3, 175, 14], [5, 30, 220],
    [7, 140, 90], [8, 65, 55], [9, 65, 55],
  ];
  for (const [i, angle, radius] of truth) {
    const c = corners[i];
    assert.ok(Math.abs(c.angle - angle) <= 8, `corner ${i}: angle ${c.angle.toFixed(1)} vs ${angle}`);
    assert.ok(Math.abs(c.radius - radius) / radius <= 0.25, `corner ${i}: radius ${c.radius.toFixed(1)} vs ${radius}`);
  }
});

test('corners that tighten or open are flagged', () => {
  const stage = R.buildStage(DemoStage.build());
  const tight = stage.notes.find(n => n.mods && n.mods.includes('tightens'));
  assert.equal(tight.text, '4 right tightens 2');
  const opens = stage.notes.find(n => n.mods && n.mods.includes('opens'));
  assert.equal(opens.dir, 'R');
});

test('slow corners after long straights get a caution', () => {
  const stage = R.buildStage(DemoStage.build());
  const hairpin = stage.notes.find(n => n.kind === 'hairpin');
  assert.equal(hairpin.text, 'Caution, hairpin left');
  // The 3 left right after a 90 m straight is not a caution.
  assert.equal(stage.notes[1].caution, false);
});

test('close corners are chained into one call with rally link words', () => {
  const stage = R.buildStage(DemoStage.build());
  const texts = stage.calls.map(c => c.text);
  assert.ok(texts.includes('5 right, 100, 3 left into 2 right, 400'), texts.join('\n'));
  assert.ok(texts.some(t => t.includes('3 right and 3 left, 500')), texts.join('\n'));
  assert.equal(texts[texts.length - 1], 'Finish');
  // Every note belongs to exactly one call, in order.
  assert.deepEqual(stage.calls.flatMap(c => c.notes.map(n => n.id)), stage.notes.map(n => n.id));
});

test('a Google junction maneuver becomes a square with the street name', () => {
  const stage = R.buildStage(DemoStage.build());
  const sq = stage.notes.find(n => n.kind === 'square');
  assert.equal(sq.junction.maneuver, 'TURN_RIGHT');
  assert.equal(sq.street, 'Quarry Rd');
  assert.equal(sq.caution, false);
});

test('a straight road with map jitter produces no corners', () => {
  let seed = 3;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const path = straightPath({ lat: 40.8, lng: -73.2 }, 75, 3000, 12).map(p => {
    const q = R.offset(p, rnd() * 360, rnd());
    return { lat: Math.round(q.lat * 1e5) / 1e5, lng: Math.round(q.lng * 1e5) / 1e5 };
  });
  const stage = R.buildStage({ path });
  assert.deepEqual(stage.notes.map(n => n.kind), ['finish']);
});

test('turn maneuvers with no visible bend still get called', () => {
  const start = { lat: 40.8, lng: -73.2 };
  const path = straightPath(start, 0, 600);
  const stage = R.buildStage({
    path,
    steps: [
      { index: 0, maneuver: 'DEPART' },
      { s: 200, maneuver: 'turn-left', instruction: 'Turn <b>left</b> onto <b>Main St</b>' },
      { s: 400, maneuver: 'FORK_RIGHT', instruction: 'Keep right at the fork' },
    ],
  });
  assert.deepEqual(stage.notes.map(n => n.text), ['Square left', 'Keep right', 'Finish']);
  assert.equal(stage.notes[0].street, 'Main St');
});

test('roundabouts replace the wiggle with the exit number', () => {
  const layout = [
    { straight: 200 },
    { turn: 'R', angle: 35, radius: 20 },
    { turn: 'L', angle: 120, radius: 18 },
    { turn: 'R', angle: 85, radius: 20 },
    { straight: 300 },
  ];
  const route = DemoStage.build(layout);
  route.steps.push({ s: 195, maneuver: 'ROUNDABOUT_LEFT', instruction: 'At the roundabout, take the 2nd exit onto Ocean Ave' });
  const stage = R.buildStage(route);
  assert.deepEqual(stage.notes.map(n => n.text), ['Roundabout, exit 2', 'Finish']);
});

test('parses exits and street names from instructions', () => {
  assert.equal(R.parseExit('At the roundabout, take the 3rd exit'), 3);
  assert.equal(R.parseExit('Take the first exit'), 1);
  assert.equal(R.parseExit('Turn left'), null);
  assert.equal(R.parseStreet('Turn right onto NY-25A E'), 'NY-25A E');
  assert.equal(R.parseStreet('Turn right onto Main St Destination will be on the left'), 'Main St');
});

test('grading and link words', () => {
  assert.equal(R.gradeFor(R.lineRadius(10, 90, 1.5)), 1);
  assert.equal(R.gradeFor(R.lineRadius(100, 60, 1.5)), 4);
  assert.equal(R.gradeFor(500), null);
  // A 20° bend can be driven almost straight, so it grades much faster.
  assert.ok(R.lineRadius(30, 20, 1.5) > 120);
  assert.equal(R.linkWord(5), 'into');
  assert.equal(R.linkWord(30), 'and');
  assert.equal(R.linkWord(93), '100');
  assert.equal(R.linkWord(2600), '1000');
});

test('simulated drive: tracker follows the car and every call fires once, in time', () => {
  const stage = R.buildStage(DemoStage.build());
  const sim = new R.Simulator(stage);
  const tracker = new R.Tracker(stage);
  const scheduler = new R.CallScheduler(stage.calls);
  const fired = [];
  let lastS = -1;
  while (!sim.done) {
    const fix = sim.step(0.5);
    const pos = tracker.update(fix);
    assert.ok(Math.abs(pos.s - sim.s) < 3, `tracker ${pos.s} vs sim ${sim.s}`);
    assert.ok(pos.s >= lastS - 1);
    assert.equal(pos.offRoute, false);
    lastS = pos.s;
    for (const call of scheduler.update(pos.s, pos.speed)) {
      fired.push(call.id);
      const ahead = call.start - pos.s;
      assert.ok(ahead >= 0, `call ${call.id} fired ${-ahead} m late`);
      if (call.start > 120) assert.ok(ahead >= 45, `call ${call.id} only ${ahead.toFixed(0)} m ahead`);
    }
  }
  assert.deepEqual(fired, stage.calls.map(c => c.id));
  assert.ok(sim.t > 60 && sim.t < 600, `stage took ${sim.t}s`);
});

test('tracker flags off-route after several far fixes', () => {
  const stage = R.buildStage(DemoStage.build());
  const tracker = new R.Tracker(stage);
  const p = R.pointAt(stage.samples, 400);
  tracker.update({ ...p, accuracy: 5, timestamp: 0 });
  const away = R.offset(p, 90, 200);
  let res;
  for (let i = 1; i <= 3; i++) res = tracker.update({ ...away, accuracy: 5, timestamp: i * 1000 });
  assert.equal(res.offRoute, true);
  res = tracker.update({ ...R.pointAt(stage.samples, 420), accuracy: 5, timestamp: 4000 });
  assert.equal(res.offRoute, false);
});

test('speed filter prefers GPS Doppler speed and smooths it', () => {
  const f = new R.SpeedFilter();
  const p = { lat: 40.8, lng: -73.2 };
  let v;
  for (let i = 0; i < 10; i++) v = f.update({ ...R.offset(p, 90, i * 20), speed: 20 + (i % 2 ? 0.4 : -0.4), accuracy: 5, timestamp: i * 1000 });
  assert.ok(Math.abs(v - 20) < 0.5, `speed ${v}`);
  assert.equal(f.source, 'doppler');
  // A single absurd reading (GPS glitch) can't add more than ~1 g in a second.
  v = f.update({ ...R.offset(p, 90, 200), speed: 80, accuracy: 5, timestamp: 10000 });
  assert.ok(Math.abs(v - 20) < 1, `spike leaked through: ${v}`);
  // Real hard braking still shows up within a couple of seconds.
  for (let i = 11; i <= 13; i++) v = f.update({ ...R.offset(p, 90, 200 + (i - 10) * 10), speed: 20 - (i - 10) * 6, accuracy: 5, timestamp: i * 1000 });
  assert.ok(v < 5, `braking lagged: ${v}`);
});

test('speed filter falls back to positions when the phone gives no speed', () => {
  let seed = 11;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const f = new R.SpeedFilter();
  const p = { lat: 40.8, lng: -73.2 };
  let v;
  for (let i = 0; i < 20; i++) {
    const q = R.offset(R.offset(p, 45, i * 15), rnd() * 360, rnd() * 3); // 15 m/s with 3 m jitter
    v = f.update({ ...q, speed: null, accuracy: 6, timestamp: i * 1000 });
  }
  assert.equal(f.source, 'position');
  assert.ok(Math.abs(v - 15) < 2, `speed ${v}`);
});

test('speed filter reads zero while parked despite GPS wander', () => {
  let seed = 5;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const f = new R.SpeedFilter();
  const p = { lat: 40.8, lng: -73.2 };
  let v;
  for (let i = 0; i < 15; i++) v = f.update({ ...R.offset(p, rnd() * 360, rnd() * 6), accuracy: 8, timestamp: i * 1000 });
  assert.equal(v, 0);
});
