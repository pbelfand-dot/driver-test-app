/*
 * Street maps for the briefing screen and the drive screen's map view.
 * Two interchangeable versions with the same small interface:
 *   googleMap(container, loadMaps)  Google Maps (needs an API key)
 *   leafletMap(container)           OpenStreetMap via Leaflet (free; standard OSM tiles,
 *                                   darkened with a CSS filter — light personal use only)
 * Interface: ready() → Promise, drawStage(stage, style), setCar(point, heading),
 *            follow(point, zoom), clearCar(), resize()
 * style = {color(note) → css colour, label(note) → text}
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

  // ── Google Maps ──

  const DARK_STYLE = [
    { elementType: 'geometry', stylers: [{ color: '#15191f' }] },
    { elementType: 'labels.text.fill', stylers: [{ color: '#8b95a5' }] },
    { elementType: 'labels.text.stroke', stylers: [{ color: '#0b0d10' }] },
    { featureType: 'poi', stylers: [{ visibility: 'off' }] },
    { featureType: 'transit', stylers: [{ visibility: 'off' }] },
    { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#2a313c' }] },
    { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#3a4250' }] },
    { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#0a1a2a' }] },
  ];

  function googleMap(container, loadMaps) {
    let map = null;
    let Overlay = null;
    let layers = [];
    let car = null;

    async function ready() {
      if (map) return;
      await loadMaps();
      const { Map, OverlayView } = await google.maps.importLibrary('maps');
      Overlay = class HtmlOverlay extends OverlayView {
        constructor(pos, el) {
          super();
          this.pos = pos;
          this.el = el;
        }
        onAdd() { this.getPanes().floatPane.appendChild(this.el); }
        onRemove() { this.el.remove(); }
        draw() {
          const proj = this.getProjection();
          const p = proj && proj.fromLatLngToDivPixel(new google.maps.LatLng(this.pos));
          if (!p) return;
          this.el.style.left = `${p.x}px`;
          this.el.style.top = `${p.y}px`;
        }
        setPosition(pos) {
          this.pos = pos;
          this.draw();
        }
      };
      map = new Map(container, {
        center: { lat: 40.79, lng: -73.13 },
        zoom: 10,
        disableDefaultUI: true,
        zoomControl: true,
        gestureHandling: 'greedy',
        clickableIcons: false,
        backgroundColor: '#07090c',
        styles: DARK_STYLE,
      });
    }

    return {
      kind: 'google',
      ready,
      drawStage(stage, style) {
        layers.forEach(l => l.setMap(null));
        layers = [];
        const S = stage.samples;
        layers.push(new google.maps.Polyline({ map, path: S.map(p => ({ lat: p.lat, lng: p.lng })), strokeColor: '#ffcc00', strokeOpacity: 0.55, strokeWeight: 5 }));
        for (const n of stage.notes) {
          if (n.type !== 'corner') continue;
          layers.push(new google.maps.Polyline({ map, path: slice(S, n.start, n.end), strokeColor: style.color(n), strokeOpacity: 1, strokeWeight: 7, zIndex: 2 }));
        }
        for (const n of stage.notes) {
          const o = new Overlay(notePoint(S, n), labelEl(style.label(n), style.color(n)));
          o.setMap(map);
          layers.push(o);
        }
        map.fitBounds(bounds(S), 30);
      },
      setCar(p, heading) {
        if (!car) {
          car = new Overlay(p, carEl());
          car.setMap(map);
        }
        car.setPosition(p);
        car.el.style.transform = `rotate(${heading}deg)`;
      },
      follow(p, zoom) {
        if (zoom) map.setZoom(zoom);
        map.panTo(p);
      },
      clearCar() {
        if (car) car.setMap(null);
        car = null;
      },
      resize() {},
    };
  }

  // ── OpenStreetMap via Leaflet ──

  function leafletMap(container) {
    let map = null;
    let layer = null;
    let car = null;
    let labels = [];
    const icon = el => L.divIcon({ className: 'rally-icon', html: el, iconSize: [0, 0] });

    // Hide labels that would overlap a more important one at the current zoom.
    function declutter() {
      const placed = [];
      for (const { marker, text } of labels.slice().sort((a, b) => a.priority - b.priority)) {
        const el = marker.getElement();
        if (!el) continue;
        const pt = map.latLngToContainerPoint(marker.getLatLng());
        const w = text.length * 8 + 14, h = 22;
        const box = [pt.x - w / 2, pt.y - h / 2, w, h];
        const clash = placed.some(b => box[0] < b[0] + b[2] && b[0] < box[0] + w && box[1] < b[1] + b[3] && b[1] < box[1] + h);
        el.style.display = clash ? 'none' : '';
        if (!clash) placed.push(box);
      }
    }

    return {
      kind: 'leaflet',
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
        map.on('zoomend', declutter);
      },
      drawStage(stage, style) {
        layer.clearLayers();
        labels = [];
        const S = stage.samples;
        L.polyline(S.map(p => [p.lat, p.lng]), { color: '#ffcc00', opacity: 0.55, weight: 5 }).addTo(layer);
        for (const n of stage.notes) {
          if (n.type !== 'corner') continue;
          L.polyline(slice(S, n.start, n.end).map(p => [p.lat, p.lng]), { color: style.color(n), opacity: 1, weight: 7 }).addTo(layer);
        }
        for (const n of stage.notes) {
          const p = notePoint(S, n);
          const text = style.label(n);
          const marker = L.marker([p.lat, p.lng], { icon: icon(labelEl(text, style.color(n))), interactive: false, keyboard: false }).addTo(layer);
          labels.push({ marker, text, priority: style.priority ? style.priority(n) : 0 });
        }
        const b = bounds(S);
        map.invalidateSize();
        map.fitBounds([[b.south, b.west], [b.north, b.east]], { padding: [30, 30], animate: false });
        declutter();
      },
      setCar(p, heading) {
        if (!car) {
          car = L.marker([p.lat, p.lng], { icon: icon(carEl()), interactive: false, keyboard: false, zIndexOffset: 1000 }).addTo(map);
        }
        car.setLatLng([p.lat, p.lng]);
        const el = car.getElement() && car.getElement().firstChild;
        if (el) el.style.transform = `rotate(${heading}deg)`;
      },
      follow(p, zoom) {
        map.setView([p.lat, p.lng], zoom || map.getZoom(), { animate: true });
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

  root.RallyMapView = { googleMap, leafletMap };
})(typeof self !== 'undefined' ? self : this);
