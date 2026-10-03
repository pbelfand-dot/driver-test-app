// Long Island driver test centers map. Free: OpenStreetMap map tiles (Leaflet),
// address search and driving routes from rally/providers.js — no API key.
let map, routeLayer;
let practiceOrigin = null;   // {lat, lng} when "Use my current location" was tapped
let sheetExpanded = false;

// Long Island center
const LI_CENTER = [40.789, -73.135];
const COUNTY_COLORS = { Nassau: '#4285f4', Suffolk: '#34a853' };
const Places = window.MapProviders;

function initMap() {
  map = L.map('map', { zoomControl: false }).setView(LI_CENTER, 10);
  L.control.zoom({ position: 'topright' }).addTo(map);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors · Routes: OSRM',
  }).addTo(map);
  routeLayer = L.layerGroup().addTo(map);

  addLegend();
  plotLocations();
  buildLocationList();

  document.getElementById('location-count').textContent =
    `(${LOCATIONS.length})`;
}

function plotLocations() {
  LOCATIONS.forEach(loc => {
    L.circleMarker([loc.lat, loc.lng], {
      radius: 10,
      fillColor: COUNTY_COLORS[loc.county],
      fillOpacity: 1,
      color: 'white',
      weight: 2
    })
      .addTo(map)
      .bindTooltip(loc.name)
      .on('click', () => showLocationInfo(loc));
  });
}

function buildLocationList() {
  const list = document.getElementById('location-list');
  list.innerHTML = '';

  LOCATIONS.forEach(loc => {
    const card = document.createElement('div');
    card.className = `loc-card ${loc.county.toLowerCase()}`;
    card.innerHTML = `
      <div class="loc-dot"></div>
      <div class="loc-info">
        <div class="loc-name">${loc.name}</div>
        <div class="loc-address">${loc.address}</div>
      </div>
      <span class="loc-county-badge">${loc.county}</span>
    `;
    card.addEventListener('click', () => {
      map.setView([loc.lat, loc.lng], 14);
      showLocationInfo(loc);
      collapseSheet();
    });
    list.appendChild(card);
  });
}

function showLocationInfo(loc) {
  document.getElementById('info-content').innerHTML = `
    <h3>${loc.name}</h3>
    <div class="info-row"><strong>📍</strong><span>${loc.address}</span></div>
    <div class="info-row"><strong>📞</strong><span>${loc.phone}</span></div>
    <div class="info-row"><strong>🕐</strong><span>${loc.hours}</span></div>
    ${loc.notes ? `<p class="info-note">${loc.notes}</p>` : ''}
  `;

  document.getElementById('btn-directions').onclick = () => getDirectionsToLocation(loc);
  document.getElementById('btn-street-view').onclick = () => openStreetView(loc);

  document.getElementById('info-panel').classList.remove('hidden');
}

function closeInfoPanel() {
  document.getElementById('info-panel').classList.add('hidden');
  routeLayer.clearLayers();
}

function getDirectionsToLocation(loc) {
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      pos => routeTo({ lat: pos.coords.latitude, lng: pos.coords.longitude }, loc),
      () => promptAddressForDirections(loc),
      { enableHighAccuracy: true, timeout: 15000 }
    );
  } else {
    promptAddressForDirections(loc);
  }
}

async function findPlace(address) {
  const found = await Places.searchPlaces(`${address}, Long Island, NY`, { lat: LI_CENTER[0], lng: LI_CENTER[1] }, 1);
  return found[0] || null;
}

async function promptAddressForDirections(loc) {
  const addr = prompt('Enter your starting address:');
  if (!addr) return;
  try {
    const place = await findPlace(addr);
    if (!place) throw new Error('not found');
    routeTo(place, loc);
  } catch (e) {
    alert('Could not find that address. Try being more specific.');
  }
}

function drawRoute(route) {
  routeLayer.clearLayers();
  const line = L.polyline(route.path.map(p => [p.lat, p.lng]), { color: '#1a73e8', weight: 5, opacity: 0.9 }).addTo(routeLayer);
  map.fitBounds(line.getBounds(), { padding: [30, 30] });
}

const tripText = route => `${(route.distance / 1609.344).toFixed(1)} mi · ${Math.round(route.duration / 60)} min`;

async function routeTo(origin, destination) {
  try {
    const route = await Places.routeOsrm(origin, { lat: destination.lat, lng: destination.lng });
    drawRoute(route);
    const panel = document.getElementById('info-content');
    const old = panel.querySelector('.trip-info');
    if (old) old.remove();
    const tripInfo = document.createElement('div');
    tripInfo.className = 'info-row trip-info';
    tripInfo.innerHTML = `<strong>🚗</strong><span>${tripText(route)}</span>`;
    panel.appendChild(tripInfo);
  } catch (e) {
    alert('Could not get directions. Please try again.');
  }
}

// Street-level photos open in Google Maps (a free link, no key needed).
function openStreetView(loc) {
  window.open(`https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${loc.lat},${loc.lng}`, '_blank', 'noopener');
}

// ── Bottom Sheet ──
function toggleSheet() {
  sheetExpanded = !sheetExpanded;
  const sheet = document.getElementById('bottom-sheet');
  if (sheetExpanded) {
    sheet.style.transform = `translateY(calc(-80vh + ${getComputedStyle(document.documentElement).getPropertyValue('--sheet-peek')}))`;
  } else {
    sheet.style.transform = 'translateY(0)';
  }
}

function collapseSheet() {
  sheetExpanded = false;
  document.getElementById('bottom-sheet').style.transform = 'translateY(0)';
}

// ── Practice Route Modal ──
function openPracticeModal() {
  document.getElementById('practice-modal').classList.remove('hidden');
  document.getElementById('overlay').classList.remove('hidden');
  document.getElementById('practice-status').className = 'hidden';
}

function closePracticeModal() {
  document.getElementById('practice-modal').classList.add('hidden');
  document.getElementById('overlay').classList.add('hidden');
}

function closeAll() {
  closePracticeModal();
  closeInfoPanel();
}

function useMyLocation() {
  if (!navigator.geolocation) {
    alert('Geolocation is not supported on this device.');
    return;
  }
  navigator.geolocation.getCurrentPosition(
    pos => {
      practiceOrigin = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      document.getElementById('practice-address').value =
        `My location (${practiceOrigin.lat.toFixed(5)}, ${practiceOrigin.lng.toFixed(5)})`;
    },
    () => alert('Could not get your location. Please type your address instead.'),
    { enableHighAccuracy: true, timeout: 15000 }
  );
}

async function generatePracticeRoute() {
  const address = document.getElementById('practice-address').value.trim();
  const minutes = parseInt(document.getElementById('practice-duration').value, 10);

  if (!address) {
    showStatus('Please enter your starting address or use your current location.', true);
    return;
  }

  showStatus('Building your practice route...', false);

  let origin = practiceOrigin && address.startsWith('My location') ? practiceOrigin : null;
  if (!origin) {
    try {
      origin = await findPlace(address);
    } catch (e) {
      origin = null;
    }
    if (!origin) {
      showStatus('Could not find that address. Try adding the city and state.', true);
      return;
    }
  }

  // Loop route: origin → waypoint A → waypoint B → origin.
  // Distance per leg based on minutes (avg ~25 mph in suburban LI).
  const milesPerMin = 25 / 60;
  const legDeg = (milesPerMin * minutes) / 3 / 69; // rough degrees
  const via = [
    { lat: origin.lat + legDeg, lng: origin.lng + legDeg * 0.5 },
    { lat: origin.lat + legDeg * 0.3, lng: origin.lng - legDeg * 0.8 }
  ];

  try {
    const route = await Places.routeOsrm(origin, origin, { via });
    drawRoute(route);
    showStatus(`✅ Practice route ready! ${tripText(route)} drive.\nTap the map to follow the blue route.`, false);
    closePracticeModal();
  } catch (e) {
    showStatus('Could not build a route from that location. Make sure you\'re on Long Island!', true);
  }
}

function showStatus(msg, isError) {
  const el = document.getElementById('practice-status');
  el.textContent = msg;
  el.className = isError ? 'error' : '';
  el.style.display = 'block';
}

function addLegend() {
  const legend = L.control({ position: 'bottomleft' });
  legend.onAdd = () => {
    const div = L.DomUtil.create('div');
    div.id = 'legend';
    div.innerHTML = Object.keys(COUNTY_COLORS).map(county => `
      <div class="legend-item">
        <div class="legend-dot" style="background:${COUNTY_COLORS[county]}"></div>
        <span>${county} County</span>
      </div>`).join('');
    return div;
  };
  legend.addTo(map);
}

document.addEventListener('DOMContentLoaded', initMap);
