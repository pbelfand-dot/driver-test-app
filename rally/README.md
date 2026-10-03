# Rally Co-Driver GPS

A phone app that turns any drive into a rally stage. Type where you're going and
it finds the route, reads the road shape, and a co-driver calls the corners out
over a radio intercom as you drive: **"5 right, 100, 3 left into 2 right, 400"**.

It also calls traffic lights, stop signs, speed cameras, rail crossings and speed
bumps, and shows the posted speed limit next to a GPS speedometer that turns red
when you're over it.

> Notes describe the road's shape, not a safe speed. Obey speed limits and
> traffic laws, and keep your eyes on the road.

## Put it on your phone

The app is a website that installs like an app (full screen, its own icon). It
needs to be served over HTTPS, and GitHub Pages does that for free:

1. On GitHub open **pbelfand-dot/driver-test-app → Settings → Pages**.
2. Under **Build and deployment**, set **Source: Deploy from a branch**, pick the
   branch that has the `rally/` folder (e.g. `claude/focused-johnson-xpi0q4`),
   folder **/ (root)**, and **Save**.
3. After a minute the app is live at
   **https://pbelfand-dot.github.io/driver-test-app/rally/**

Then on the phone:

- **iPhone:** open that link in **Safari** → Share button → **Add to Home Screen**.
- **Android:** open it in **Chrome** → ⋮ menu → **Install app** (or Add to Home screen).

Open it from the new icon and allow **Location** when asked.

## Using it

1. Leave **From** empty to start where you are, type a destination in **To** and
   pick it from the suggestions. Tick *Twisty mode* to avoid highways.
2. **Build stage** finds the fastest route, then checks it for lights, signs,
   cameras and speed limits. The briefing screen shows the map and the full
   pace-note book (tap any line to hear it).
3. **▶ Start stage** and drive. Keep the app open with the screen on (mount the
   phone); it keeps the screen awake by itself. Go off route and it recalculates.
4. **Simulate drive** plays the stage at your desk. The **Demo stage** on the
   first screen needs no address at all.

**Waze (cop alerts)** and **Google Maps** buttons open the same destination in
those apps.

### Reading the notes

| Note | Meaning |
|---|---|
| **6 … 1** + left/right | how fast the bend is: 6 = nearly flat, 1 = very slow |
| **Square** | ~90° turn at a junction |
| **Hairpin** | ~180° bend |
| **tightens / opens** | the bend gets slower / faster on the way through |
| **long** | bend keeps turning for a while |
| **30 … 1000** | metres of straight to the next note |
| **into / and** | the next note comes immediately / very soon |
| **Caution** | slow bend at the end of a long straight |
| **at lights / at stop sign** | the junction turn is at lights / a stop sign |

## Sound, iPhone and CarPlay

- The co-driver uses a recorded voice pack (made with Higgsfield, listed in
  `voice/manifest.json`), stitched together and run through a radio-intercom
  effect. If a word is ever missing it falls back to the phone's own voice.
- By default the callouts play like media so they're heard **with the silent
  switch on** and should come through the car speakers over CarPlay; on an
  iPhone this pauses other audio. Turn on **Keep my music playing** in
  Co-driver settings to mix with music instead — then the silent switch mutes
  the co-driver.
- A web app **can't appear on the CarPlay screen** and **can't use GPS with the
  screen off or the app in the background**. Use CarPlay for maps/music and keep
  this app open on the phone. A native app is needed for those (see below).

## Where the data comes from

With no setup the app uses free OpenStreetMap services:

| What | Service |
|---|---|
| Address search | Photon (photon.komoot.io), Nominatim as backup |
| Routing | OSRM on FOSSGIS `routing.openstreetmap.de` (OSRM demo server as backup) |
| Lights, signs, cameras, speed limits | Overpass API (`overpass-api.de`) |
| Map | OpenStreetMap standard tiles via Leaflet |

These are community servers for **light, personal use**: about one route and a
few look-ups per drive is fine. Sharing the app widely would need your own
servers or paid providers. Coverage depends on what volunteers have mapped:
some lights, cameras or speed limits will be missing — fix them at
openstreetmap.org.

**Optional Google routing:** put a Google Maps Platform key in `../config.js`
(enable *Maps JavaScript API* and *Routes API*, and restrict the key to your
site). Routes then come from Google, falling back to OpenStreetMap if Google
fails. Road features still come from OpenStreetMap.

**Police reports:** there is no public API for live police reports (Waze and
Google don't offer one), so the app links to Waze for them. Speed-camera
locations come from OpenStreetMap; warning about cameras is legal in the US but
banned in some countries (e.g. Germany, France).

## A real native app / CarPlay

A native iPhone app with a CarPlay screen needs: an Apple Developer Program
membership ($99/year), a Mac with Xcode, and Apple's approval of the CarPlay
**Navigation** entitlement (requested at developer.apple.com/contact/carplay).
The pace-note engine (`pacenotes.js`) is plain JavaScript and can be reused in a
React Native (e.g. `react-native-carplay`) or Capacitor app.

## Development

```sh
npx http-server -p 8080 .        # from the repo root, then open http://localhost:8080/rally/
node --test rally/test/*.test.js # unit tests
```

| File | What it does |
|---|---|
| `pacenotes.js` | Pace-note engine: corner detection and grading, call chaining, GPS tracking, speed filter, simulator |
| `providers.js` | OpenStreetMap services: search, OSRM routing, Overpass road features |
| `voicepack.js` | Radio intercom effect, voice-pack loading, stitching and rendering |
| `mapview.js` | Google Maps / Leaflet map views |
| `app.js` | Screens, routing flow, co-driver queue, HUD |
| `demo-stage.js` | Made-up test road used by the demo and the tests |
| `sw.js`, `manifest.webmanifest`, `icons/` | Installable app + offline start |
| `vendor/leaflet/` | Leaflet 1.9.4 (BSD-2-Clause) |
