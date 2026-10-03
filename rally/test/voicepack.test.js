// Run with: node --test rally/test/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const R = require('../pacenotes.js');
const V = require('../voicepack.js');
const DemoStage = require('../demo-stage.js');
const { overpassFor } = require('./fixtures.js');
const P = require('../providers.js');

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'voice', 'manifest.json'), 'utf8'));
const have = new Set(Object.keys(manifest.clips));

test('calls split into recorded words', () => {
  assert.deepEqual(V.tokenize('Caution, 2 right opens, 300'), ['caution', ',', '2', 'right', 'opens', ',', '300']);
  assert.deepEqual(V.tokenize('5 right, 100, 3 left into 2 right, 400'), ['5', 'right', ',', '100', ',', '3', 'left', 'into', '2', 'right', ',', '400']);
  assert.deepEqual(V.tokenize('Square right at stop sign'), ['square', 'right', 'at', 'stop-sign']);
  assert.deepEqual(V.tokenize('Three'), ['3']);
  assert.deepEqual(V.tokenize('Go!'), ['go']);
  assert.deepEqual(V.tokenize('Off route. Recalculating.'), ['off-route']);
  assert.deepEqual(V.tokenize('Co-driver ready. Stage start.'), ['ready']);
});

test('the voice pack has every word the app can say', () => {
  const stage = R.buildStage(Object.assign(DemoStage.build(), P.parseOverpass(overpassFor(R.buildStage(DemoStage.build())))));
  const lines = stage.calls.map(c => c.text).concat([
    'Three', 'Two', 'One', 'Go!', 'Stage complete.', 'Off route. Recalculating.', 'New route. Notes on.',
    'Co-driver ready. Stage start.', 'Could not recalculate.', '4 left, 100, 3 right tightens 2, caution, hairpin left.',
    'Roundabout, exit 2', 'Keep left', 'Ramp right', 'Merge', 'Ferry', 'Speed camera', 'Rail crossing', 'Bump', 'Lights',
    '1 left at stop sign', '6 right long, 1000',
  ]);
  for (const d of [30, 40, 50, 60, 70, 80, 100, 120, 150, 200, 250, 300, 350, 400, 450, 500, 600, 700, 800, 900, 1000]) lines.push(`4 left, ${d}`);
  for (const line of lines) {
    const missing = V.tokenize(line).filter(t => t !== ',' && !have.has(t));
    assert.deepEqual(missing, [], `"${line}" needs ${missing.join(', ')}`);
  }
});
