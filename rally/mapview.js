/*
 * Street maps for the briefing screen and the drive screen. All free:
 *
 *   glMap(container)      MapLibre GL with OpenFreeMap vector tiles (no key, no
 *                         limits). Rotates with your heading and tilts, like a
 *                         navigation app. Falls back to plain OpenStreetMap tiles.
 *   leafletMap(container) Leaflet + OpenStreetMap tiles, north-up only. Used
 *                         when the phone can't do WebGL.
 *
 * Interface: ready() → Promise, drawStage(stage, style), setProgress(s),
 *   follow(point, heading, speed, ms), setCar(point, heading), clearCar(),
 *   overview(), track(on), onUserMove(fn), resize()
 * style = {color(note) → css colour, label(note) → text, priority(note) → number}
 */
(function (root) {
  'use strict';

  const N = root.RallyNotes;

  function bounds(samples) {
    let north = -90, south = 90, east = -180, west = 180;
    for (const p of samples) {
      north = Math.max(north, p.lat); south = Math.min(south, p.lat);
      east = Math.max(east, p.lng); west = Math.min(west, p.lng);
    }
    return { north, south, east, west };
  }

  const slice = (S, a, b) => S.slice(N.indexAt(S, a), N.indexAt(S, b) + 2).map(p => ({ lat: p.lat, lng: p.lng }));
  const notePoint = (S, n) => N.pointAt(S, n.apex !== undefined ? n.apex : n.start);

  function labelEl(text, color) {
    const el = document.createElement('div');
    el.className = 'map-label';
    el.style.background = color;
    el.textContent = text;
    return el;
  }

  function carEl() {
    const el = document.createElement('div');
    el.className = 'map-car';
    return el;
  }

  // Hide labels that overlap a more important one. project(label) → {x, y}.
  function declutter(labels, project, hiddenBefore) {
    const placed = [];
    for (const lb of labels.slice().sort((a, b) => a.priority - b.priority)) {
      if (lb.note.end < hiddenBefore) {
        lb.el.style.visibility = 'hidden';
        continue;
      }
      const pt = project(lb);
      const w = lb.text.length * 8 + 14, h = 22;
      const box = [pt.x - w / 2, pt.y - h / 2, w, h];
      const clash = placed.some(b => box[0] < b[0] + b[2] && b[0] < box[0] + w && box[1] < b[1] + b[3] && b[1] < box[1] + h);
      lb.el.style.visibility = clash ? 'hidden' : '';
      if (!clash) placed.push(box);
    }
  }

  // ── MapLibre GL + OpenFreeMap ──

  function glSupported() {
    try {
      const c = document.createElement('canvas');
      return !!(root.maplibregl && (c.getContext('webgl2') || c.getContext('webgl')));
    } catch (e) {
      return false;
    }
  }

  const OSM_RASTER = {
    version: 8,
    sources: {
      osm: {
        type: 'raster',
        tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
        tileSize: 256,
        maxzoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      },
    },
    layers: [{ id: 'osm', type: 'raster', source: 'osm', paint: { 'raster-brightness-max': 0.5, 'raster-saturation': -0.6 } }],
  };
  // Dark first, then OpenFreeMap's maintained style, then plain OSM tiles.
  const STYLES = ['https://tiles.openfreemap.org/styles/dark', 'https://tiles.openfreemap.org/styles/liberty', OSM_RASTER];

  const ROUTE_LAYERS = [
    { id: 'route-casing', source: 'route', paint: { 'line-color': '#0b1220', 'line-width': 12, 'line-opacity': 0.85 } },
    { id: 'route-line', source: 'route', paint: { 'line-color': '#4c8dff', 'line-width': 7 } },
    { id: 'route-corners', source: 'corners', paint: { 'line-color': ['get', 'color'], 'line-width': 7 } },
    { id: 'route-done', source: 'done', paint: { 'line-color': '#5b6472', 'line-width': 7 } },
  ];

  function glMap(container) {
    let map = null;
    let styleIndex = 0;
    let styleLoaded = false;
    let styleTimer = null;
    let data = null;          // {route, corners, done} GeoJSON
    let labels = [];
    let car = null;
    let tracking = true;
    let userMove = null;
    let stage = null;
    let progress = -Infinity;

    const empty = { type: 'FeatureCollection', features: [] };
    const line = pts => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: pts.map(p => [p.lng, p.lat]) } });

    function addLayers() {
      if (!map || !styleLoaded || !data) return;
      for (const id of ['route', 'corners', 'done']) {
        if (map.getSource(id)) map.getSource(id).setData(data[id]);
        else map.addSource(id, { type: 'geojson', data: data[id] });
      }
      for (const l of ROUTE_LAYERS) {
        if (!map.getLayer(l.id)) map.addLayer({ id: l.id, type: 'line', source: l.source, layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: l.paint });
      }
    }

    function nextStyle() {
      if (styleIndex >= STYLES.length - 1) return;
      styleIndex++;
      styleLoaded = false;
      map.setStyle(STYLES[styleIndex]);
      armStyleTimer();
    }

    function armStyleTimer() {
      clearTimeout(styleTimer);
      styleTimer = setTimeout(() => { if (!styleLoaded) nextStyle(); }, 8000);
    }

    function relabel() {
      if (!map) return;
      declutter(labels, lb => map.project(lb.marker.getLngLat()), progress);
    }

    return {
      kind: 'gl',
      container,
      async ready() {
        if (map) return;
        if (!glSupported()) throw new Error('WebGL not available');
        map = new root.maplibregl.Map({
          container,
          style: STYLES[0],
          center: [-73.13, 40.79],
          zoom: 10,
          maxPitch: 70,
          attributionControl: { compact: true },
        });
        armStyleTimer();
        map.on('style.load', () => {
          styleLoaded = true;
          clearTimeout(styleTimer);
          addLayers();
        });
        // A style that fails to load moves on to the next one; later tile errors are ignored.
        map.on('error', () => { if (!styleLoaded) nextStyle(); });
        for (const ev of ['dragstart', 'rotatestart', 'pitchstart', 'zoomstart']) {
          map.on(ev, e => {
            if (!e.originalEvent) return;
            tracking = false;
            if (userMove) userMove();
          });
        }
        map.on('moveend', relabel);
      },

      drawStage(st, style) {
        stage = st;
        progress = -Infinity;
        const S = st.samples;
        data = {
          route: line(S),
          corners: {
            type: 'FeatureCollection',
            features: st.notes.filter(n => n.type === 'corner').map(n => Object.assign(line(slice(S, n.start, n.end)), { properties: { color: style.color(n) } })),
          },
          done: empty,
        };
        addLayers();
        labels.forEach(lb => lb.marker.remove());
        labels = st.notes.map(n => {
          const p = notePoint(S, n);
          const el = labelEl(style.label(n), style.color(n));
          const marker = new root.maplibregl.Marker({ element: el }).setLngLat([p.lng, p.lat]).addTo(map);
          return { marker, el, text: style.label(n), note: n, priority: style.priority ? style.priority(n) : 0 };
        });
        this.overview(0);
      },

      // Grey out the part of the route already driven and hide its labels.
      setProgress(s) {
        if (!stage || !map) return;
        progress = s;
        const S = stage.samples;
        data.done = s > 1 ? line(S.slice(0, N.indexAt(S, s) + 1).concat([N.pointAt(S, s)])) : empty;
        if (styleLoaded && map.getSource('done')) map.getSource('done').setData(data.done);
      },

      setCar(p, heading) {
        if (!car) {
          car = new root.maplibregl.Marker({ element: carEl(), rotationAlignment: 'map', pitchAlignment: 'map' }).setLngLat([p.lng, p.lat]).addTo(map);
        }
        car.setLngLat([p.lng, p.lat]);
        car.setRotation(heading);
      },

      // Navigation camera: heading up, tilted, car in the lower part of the screen,
      // zoomed out a little at speed.
      follow(p, heading, speed, ms) {
        this.setCar(p, heading);
        if (!tracking) return;
        const h = container.clientHeight || 400;
        const zoom = speed > 27 ? 15.3 : speed > 18 ? 16 : speed > 9 ? 16.7 : 17.2;
        map.easeTo({
          center: [p.lng, p.lat],
          bearing: heading,
          pitch: 55,
          zoom,
          padding: { top: Math.round(h * 0.42), bottom: 20, left: 0, right: 0 },
          duration: ms || 900,
          easing: t => t,
        });
      },

      overview(ms = 800) {
        if (!stage || !map) return;
        tracking = false;
        const b = bounds(stage.samples);
        map.resize();
        map.fitBounds([[b.west, b.south], [b.east, b.north]], {
          padding: 40, bearing: 0, pitch: 0, duration: ms,
        });
        if (!ms) relabel();
      },

      track(on) {
        tracking = on;
      },

      get tracking() {
        return tracking;
      },

      onUserMove(fn) {
        userMove = fn;
      },

      clearCar() {
        if (car) car.remove();
        car = null;
      },

      resize() {
        if (map) map.resize();
      },
    };
  }

  // ── OpenStreetMap via Leaflet (no WebGL) ──

  function leafletMap(container) {
    let map = null;
    let layer = null;
    let done = null;
    let car = null;
    let labels = [];
    let tracking = true;
    let userMove = null;
    let stage = null;
    let progress = -Infinity;
    const icon = el => L.divIcon({ className: 'rally-icon', html: el, iconSize: [0, 0] });
    const relabel = () => declutter(labels, lb => map.latLngToContainerPoint(lb.marker.getLatLng()), progress);

    return {
      kind: 'leaflet',
      container,
      async ready() {
        if (map) return;
        if (!root.L) throw new Error('Map library missing');
        map = L.map(container, { zoomControl: true, attributionControl: true }).setView([40.79, -73.13], 10);
        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 19,
          className: 'osm-tiles',
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        }).addTo(map);
        layer = L.layerGroup().addTo(map);
        map.on('zoomend moveend', relabel);
        map.on('dragstart', () => {
          tracking = false;
          if (userMove) userMove();
        });
      },
      drawStage(st, style) {
        stage = st;
        progress = -Infinity;
        layer.clearLayers();
        labels = [];
        const S = st.samples;
        L.polyline(S.map(p => [p.lat, p.lng]), { color: '#4c8dff', opacity: 0.9, weight: 6 }).addTo(layer);
        for (const n of st.notes) {
          if (n.type !== 'corner') continue;
          L.polyline(slice(S, n.start, n.end).map(p => [p.lat, p.lng]), { color: style.color(n), opacity: 1, weight: 7 }).addTo(layer);
        }
        done = L.polyline([], { color: '#5b6472', opacity: 1, weight: 7 }).addTo(layer);
        for (const n of st.notes) {
          const p = notePoint(S, n);
          const text = style.label(n);
          const marker = L.marker([p.lat, p.lng], { icon: icon(labelEl(text, style.color(n))), interactive: false, keyboard: false }).addTo(layer);
          labels.push({ marker, el: marker.getElement().firstChild, text, note: n, priority: style.priority ? style.priority(n) : 0 });
        }
        this.overview();
      },
      setProgress(s) {
        if (!stage) return;
        progress = s;
        const S = stage.samples;
        done.setLatLngs(S.slice(0, N.indexAt(S, s) + 1).map(p => [p.lat, p.lng]));
      },
      setCar(p, heading) {
        if (!car) {
          car = L.marker([p.lat, p.lng], { icon: icon(carEl()), interactive: false, keyboard: false, zIndexOffset: 1000 }).addTo(map);
        }
        car.setLatLng([p.lat, p.lng]);
        const el = car.getElement() && car.getElement().firstChild;
        if (el) el.style.transform = `rotate(${heading}deg)`;
      },
      follow(p, heading, speed) {
        this.setCar(p, heading);
        if (!tracking) return;
        const zoom = speed > 27 ? 15 : speed > 18 ? 16 : 17;
        map.setView([p.lat, p.lng], zoom, { animate: true });
      },
      overview() {
        if (!stage) return;
        tracking = false;
        const b = bounds(stage.samples);
        map.invalidateSize();
        map.fitBounds([[b.south, b.west], [b.north, b.east]], { padding: [30, 30], animate: false });
        relabel();
      },
      track(on) {
        tracking = on;
      },
      get tracking() {
        return tracking;
      },
      onUserMove(fn) {
        userMove = fn;
      },
      clearCar() {
        if (car) car.remove();
        car = null;
      },
      resize() {
        if (map) map.invalidateSize();
      },
    };
  }

  root.RallyMapView = { glMap, leafletMap, glSupported };
})(typeof self !== 'undefined' ? self : this);
