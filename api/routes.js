const https = require('https');

const TECHNICIANS = [
  { id: 1, name: 'Nico Kussio', home: [8.3858, 51.9069], city: 'Gütersloh', color: '#3b82f6', boId: 158934 },
  { id: 2, name: 'Nico Walczak', home: [8.0011, 51.3279], city: 'Sundern', color: '#22c55e', boId: 158933 },
  { id: 3, name: 'Adem', home: [8.0011, 51.3279], city: 'Sundern', color: '#f59e0b', boId: 158932 },
  { id: 4, name: 'Ramiz', home: [7.8159, 51.6739], city: 'Hamm', color: '#ef4444', boId: 158931 },
];

function haversine(lon1, lat1, lon2, lat2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ── OSRM Trip API (echte Straßenoptimierung, kostenlos) ───────────
function osrmTrip(coords) {
  // coords = [[lon,lat], [lon,lat], ...]  — Startpunkt zuerst
  const coordStr = coords.map(c => `${c[0]},${c[1]}`).join(';');
  const path = `/trip/v1/driving/${coordStr}?roundtrip=false&source=first&destination=last&annotations=duration,distance&geometries=geojson`;
  return new Promise((resolve, reject) => {
    https.get({ hostname: 'router.project-osrm.org', path, headers: { 'User-Agent': 'JoshDashboard/1.0' } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('OSRM parse error')); }
      });
    }).on('error', reject);
  });
}

// ── Fallback: Nearest Neighbor + 2-opt ───────────────────────────
function nearestNeighborRoute(start, orders) {
  const remaining = [...orders];
  const route = [];
  let current = start;

  while (remaining.length > 0) {
    let bestIdx = 0, bestDist = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = haversine(current[0], current[1], remaining[i].coords[0], remaining[i].coords[1]);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    const next = remaining.splice(bestIdx, 1)[0];
    route.push(next);
    current = next.coords;
  }
  return twoOpt(start, route);
}

function routeDistance(start, route) {
  let d = haversine(start[0], start[1], route[0].coords[0], route[0].coords[1]);
  for (let i = 0; i < route.length - 1; i++)
    d += haversine(route[i].coords[0], route[i].coords[1], route[i+1].coords[0], route[i+1].coords[1]);
  return d;
}

function twoOpt(start, route) {
  if (route.length < 4) return route;
  let improved = true;
  let best = [...route];
  while (improved) {
    improved = false;
    for (let i = 0; i < best.length - 1; i++) {
      for (let j = i + 2; j < best.length; j++) {
        const candidate = [...best.slice(0, i+1), ...best.slice(i+1, j+1).reverse(), ...best.slice(j+1)];
        if (routeDistance(start, candidate) < routeDistance(start, best)) {
          best = candidate;
          improved = true;
        }
      }
    }
  }
  return best;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const body = req.method === 'POST'
      ? (typeof req.body === 'string' ? JSON.parse(req.body) : req.body) || {}
      : {};

    if (req.method === 'GET') {
      return res.json({ technicians: TECHNICIANS });
    }

    if (body.action === 'optimize') {
      const tech = TECHNICIANS.find(t => t.id === parseInt(body.techId));
      if (!tech) return res.status(400).json({ error: 'Techniker nicht gefunden' });

      const orders = (body.orders || []).filter(o => o.coords);
      if (!orders.length) return res.json({ tech, orders: [], totalDistance: 0, totalDuration: 0 });

      // Geographische Ausreißer markieren (>60km Luftlinie vom Techniker-Heimatort)
      const outliers = orders.map(o => ({
        ...o,
        distFromHome: Math.round(haversine(tech.home[0], tech.home[1], o.coords[0], o.coords[1]))
      }));

      let route, totalDistance, totalDuration, routeGeometry, source = 'osrm';

      try {
        // OSRM: alle Punkte inkl. Start
        const coords = [tech.home, ...orders.map(o => o.coords)];
        const osrm = await osrmTrip(coords);

        if (osrm.code !== 'Ok' || !osrm.trips?.[0]) throw new Error('OSRM: ' + (osrm.message || osrm.code));

        const trip = osrm.trips[0];
        // waypoints enthält den Index des Original-Inputs und die optimierte Position
        const waypointOrder = osrm.waypoints
          .slice(1) // slice(1) = ohne Startpunkt
          .sort((a, b) => a.waypoint_index - b.waypoint_index)
          .map(w => w.waypoint_index - 1); // -1 weil Start auf Index 0 war

        route = waypointOrder.map(i => outliers[i]);
        totalDistance = Math.round(trip.distance / 100) / 10; // Meter → km
        totalDuration = Math.round(trip.duration);
        // GeoJSON geometry vom OSRM nutzen
        routeGeometry = trip.geometry?.coordinates || [tech.home, ...route.map(o => o.coords)];

      } catch (osrmErr) {
        console.warn('[routes] OSRM failed, fallback to NN+2opt:', osrmErr.message);
        source = 'fallback';
        const sorted = nearestNeighborRoute(tech.home, outliers);
        route = sorted;
        const dist = routeDistance(tech.home, sorted);
        totalDistance = Math.round(dist * 10) / 10;
        totalDuration = Math.round(dist / 50 * 3600);
        routeGeometry = [tech.home, ...sorted.map(o => o.coords)];
      }

      return res.json({
        tech: { id: tech.id, name: tech.name, home: tech.home, color: tech.color, city: tech.city },
        orders: route,
        totalDistance,
        totalDuration,
        routeGeometry,
        source, // 'osrm' oder 'fallback'
      });
    }

    return res.status(400).json({ error: 'Nutze POST mit action=optimize.' });
  } catch (err) {
    console.error('[routes] Error:', err);
    res.status(500).json({ error: err.message });
  }
};
