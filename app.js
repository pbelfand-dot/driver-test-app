let map, directionsService, directionsRenderer, geocoder;
let markers = [];
let activeLocation = null;
let practiceOriginLatLng = null;
let sheetExpanded = false;

// Long Island center
const LI_CENTER = { lat: 40.789, lng: -73.135 };

function initMap() {
  map = new google.maps.Map(document.getElementById('map'), {
    center: LI_CENTER,
    zoom: 10,
    mapTypeControl: false,
    fullscreenControl: false,
    streetViewControl: false,
    zoomControl: true,
    zoomControlOptions: {
      position: google.maps.ControlPosition.RIGHT_CENTER
    },
    styles: [
      { featureType: 'poi', elementType: 'labels', stylers: [{ visibility: 'off' }] }
    ]
  });

  directionsService = new google.maps.DirectionsService();
  directionsRenderer = new google.maps.DirectionsRenderer({
    suppressMarkers: false,
    polylineOptions: { strokeColor: '#1a73e8', strokeWeight: 5 }
  });
  directionsRenderer.setMap(map);
  geocoder = new google.maps.Geocoder();

  addLegend();
  plotLocations();
  buildLocationList();

  document.getElementById('location-count').textContent =
    `(${LOCATIONS.length})`;
}

function plotLocations() {
  const nassauIcon = makeIcon('#4285f4');
  const suffolkIcon = makeIcon('#34a853');

  LOCATIONS.forEach(loc => {
    const marker = new google.maps.Marker({
      position: { lat: loc.lat, lng: loc.lng },
      map,
      title: loc.name,
      icon: loc.county === 'Nassau' ? nassauIcon : suffolkIcon,
      animation: google.maps.Animation.DROP
    });

    marker.addListener('click', () => showLocationInfo(loc, marker));
    markers.push({ marker, loc });
  });
}

function makeIcon(color) {
  return {
    path: google.maps.SymbolPath.CIRCLE,
    scale: 10,
    fillColor: color,
    fillOpacity: 1,
    strokeColor: 'white',
    strokeWeight: 2
  };
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
      map.panTo({ lat: loc.lat, lng: loc.lng });
      map.setZoom(14);
      showLocationInfo(loc);
      collapseSheet();
    });
    list.appendChild(card);
  });
}

function showLocationInfo(loc) {
  activeLocation = loc;

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
  directionsRenderer.setDirections({ routes: [] });
  activeLocation = null;
}

function getDirectionsToLocation(loc) {
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      pos => {
        const origin = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        routeTo(origin, { lat: loc.lat, lng: loc.lng });
      },
      () => promptAddressForDirections(loc)
    );
  } else {
    promptAddressForDirections(loc);
  }
}

function promptAddressForDirections(loc) {
  const addr = prompt('Enter your starting address:');
  if (!addr) return;
  geocoder.geocode({ address: addr + ', Long Island, NY' }, (results, status) => {
    if (status === 'OK') {
      routeTo(results[0].geometry.location, { lat: loc.lat, lng: loc.lng });
    } else {
      alert('Could not find that address. Try being more specific.');
    }
  });
}

function routeTo(origin, destination) {
  directionsService.route(
    {
      origin,
      destination,
      travelMode: google.maps.TravelMode.DRIVING
    },
    (result, status) => {
      if (status === 'OK') {
        directionsRenderer.setDirections(result);
        const leg = result.routes[0].legs[0];
        const panel = document.getElementById('info-content');
        const tripInfo = document.createElement('div');
        tripInfo.className = 'info-row';
        tripInfo.style.marginTop = '8px';
        tripInfo.style.padding = '8px';
        tripInfo.style.background = '#e8f0fe';
        tripInfo.style.borderRadius = '8px';
        tripInfo.innerHTML = `
          <strong>🚗</strong>
          <span>${leg.distance.text} · ${leg.duration.text}</span>
        `;
        panel.appendChild(tripInfo);
      } else {
        alert('Could not get directions. Please try again.');
      }
    }
  );
}

function openStreetView(loc) {
  const sv = new google.maps.StreetViewPanorama(
    document.getElementById('map'),
    {
      position: { lat: loc.lat, lng: loc.lng },
      pov: { heading: 0, pitch: 0 },
      zoom: 1
    }
  );
  map.setStreetView(sv);
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
  document.getElementById('practice-status').classList.add('hidden');
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
      practiceOriginLatLng = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      geocoder.geocode({ location: practiceOriginLatLng }, (results, status) => {
        if (status === 'OK' && results[0]) {
          document.getElementById('practice-address').value = results[0].formatted_address;
        } else {
          document.getElementById('practice-address').value =
            `${pos.coords.latitude.toFixed(5)}, ${pos.coords.longitude.toFixed(5)}`;
        }
      });
    },
    err => {
      alert('Could not get your location. Please type your address instead.');
    }
  );
}

function generatePracticeRoute() {
  const address = document.getElementById('practice-address').value.trim();
  const minutes = parseInt(document.getElementById('practice-duration').value);
  const status = document.getElementById('practice-status');

  if (!address) {
    showStatus('Please enter your starting address or use your current location.', true);
    return;
  }

  showStatus('Building your practice route...', false);

  const resolveOrigin = (callback) => {
    if (practiceOriginLatLng && document.getElementById('practice-address').value.includes(',')) {
      callback(practiceOriginLatLng);
    } else {
      geocoder.geocode({ address: address }, (results, gStatus) => {
        if (gStatus === 'OK') {
          const latlng = {
            lat: results[0].geometry.location.lat(),
            lng: results[0].geometry.location.lng()
          };
          callback(latlng);
        } else {
          showStatus('Could not find that address. Try adding the city and state.', true);
        }
      });
    }
  };

  resolveOrigin(origin => {
    // Build a loop route: origin → waypoint A → waypoint B → origin
    // Distance per leg based on minutes (avg ~25 mph in suburban LI)
    const milesPerMin = 25 / 60;
    const totalMiles = milesPerMin * minutes;
    const legMiles = totalMiles / 3;
    const legDeg = legMiles / 69; // rough degrees

    const waypoints = [
      { lat: origin.lat + legDeg, lng: origin.lng + legDeg * 0.5 },
      { lat: origin.lat + legDeg * 0.3, lng: origin.lng - legDeg * 0.8 }
    ];

    directionsService.route(
      {
        origin,
        destination: origin,
        waypoints: waypoints.map(wp => ({
          location: new google.maps.LatLng(wp.lat, wp.lng),
          stopover: false
        })),
        travelMode: google.maps.TravelMode.DRIVING,
        optimizeWaypoints: true
      },
      (result, routeStatus) => {
        if (routeStatus === 'OK') {
          directionsRenderer.setDirections(result);

          const legs = result.routes[0].legs;
          const totalDist = legs.reduce((sum, l) => sum + l.distance.value, 0);
          const totalTime = legs.reduce((sum, l) => sum + l.duration.value, 0);
          const distMi = (totalDist / 1609).toFixed(1);
          const timeMins = Math.round(totalTime / 60);

          showStatus(
            `✅ Practice route ready! ${distMi} miles · ~${timeMins} min drive.\nTap the map to follow the blue route.`,
            false
          );

          closePracticeModal();
          map.fitBounds(result.routes[0].bounds);
        } else {
          showStatus('Could not build a route from that location. Make sure you\'re on Long Island!', true);
        }
      }
    );
  });
}

function showStatus(msg, isError) {
  const el = document.getElementById('practice-status');
  el.textContent = msg;
  el.className = isError ? 'error' : '';
  el.style.display = 'block';
}

function addLegend() {
  const legend = document.createElement('div');
  legend.id = 'legend';
  legend.innerHTML = `
    <div class="legend-item">
      <div class="legend-dot" style="background:#4285f4"></div>
      <span>Nassau County</span>
    </div>
    <div class="legend-item">
      <div class="legend-dot" style="background:#34a853"></div>
      <span>Suffolk County</span>
    </div>
  `;
  map.controls[google.maps.ControlPosition.BOTTOM_LEFT].push(legend);
}
