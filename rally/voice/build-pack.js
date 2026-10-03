#!/usr/bin/env node
/*
 * Copies the voice-pack clips listed in manifest.json into this folder as
 * small MP3s (silence trimmed, mono) and rewrites the manifest to use them.
 * The app then serves its own voice: free on GitHub Pages, works offline and
 * no longer depends on the clip host. Runs in GitHub Actions
 * (.github/workflows/voice-pack.yml) or locally:
 *
 *   node rally/voice/build-pack.js        # needs ffmpeg on PATH
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const dir = __dirname;
const manifestPath = path.join(dir, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

if (Array.isArray(manifest.clips)) {
  console.log('Voice pack is already stored locally; nothing to do.');
  process.exit(0);
}

// Trim leading and trailing silence; a few ms of padding keeps word endings crisp.
const TRIM = 'silenceremove=start_periods=1:start_threshold=-45dB,areverse,' +
  'silenceremove=start_periods=1:start_threshold=-45dB,areverse,apad=pad_dur=0.02';

(async () => {
  const names = Object.keys(manifest.clips);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-'));
  for (const name of names) {
    const url = (manifest.base || '') + manifest.clips[name];
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status} for ${url}`);
    const wav = path.join(tmp, `${name}.wav`);
    fs.writeFileSync(wav, Buffer.from(await res.arrayBuffer()));
    execFileSync('ffmpeg', [
      '-loglevel', 'error', '-y', '-i', wav, '-af', TRIM,
      '-ac', '1', '-ar', '24000', '-c:a', 'libmp3lame', '-b:a', '64k',
      path.join(dir, `${name}.mp3`),
    ]);
    console.log(`saved ${name}.mp3`);
  }
  const local = {
    voice: manifest.voice,
    format: 'mp3',
    clips: names,
    source: { base: manifest.base, clips: manifest.clips },
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(local, null, 2)}\n`);
  console.log(`Stored ${names.length} clips locally.`);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
