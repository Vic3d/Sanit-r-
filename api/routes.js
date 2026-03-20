const https = require('https');

const TECHNICIANS = [
  { id: 1, name: 'Nico Kussio',  home: [8.3858, 51.9069], city: 'Gütersloh', color: '#3b82f6', boId: 158934 },
  { id: 2, name: 'Nico Walczak', home: [8.0011, 51.3279], city: 'Sundern',   color: '#22c55e', boId: 158933 },
  { id: 3, name: 'Adem',         home: [8.0011, 51.3279], city: 'Sundern',   color: '#f59e0b', boId: 158932 },
  { id: 4, name: 'Ramiz',        home: [7.8159, 51.6739], city: 'Hamm',      color: '#ef4444', boId: 158931 },
];

function haversine(lon1, lat1, lon2, lat2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// Für jeden Auftrag: welcher Techniker ist am nächsten?
function bestTechForOrder(order, allTechs) {
  let best = null, bestDist = Infinity;
  for (const t of allTechs) {
    const d = haversine(t.home[0], t.home[1], order.coords[0], order.coords[1]);
    if (d < bestDist) { bestDist = d; best = t; }
  }
  return { tech: best, dist: Math.round(bestDist) };
}

// ── OSRM Trip API (echte Straßenoptimierung) ──────────────────────
function osrmTrip(coords) {
  const coordStr = coords.map(c => `${c[0]},${c[1]}`).join(';');
  const path = `/trip/v1/driving/${coordStr}?roundtrip=true&source=first&annotations=duration,distance&geometries=geojson`;
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
function routeDistTotal(start, route) {
  if (!route.length) return 0;
  let d = haversine(start[0], start[1], route[0].coords[0], route[0].coords[1]);
  for (let i = 0; i < route.length - 1; i++)
    d += haversine(route[i].coords[0], route[i].coords[1], route[i+1].coords[0], route[i+1].coords[1]);
  d += haversine(route[route.length-1].coords[0], route[route.length-1].coords[1], start[0], start[1]);
  return d;
}

function nearestNeighborRoute(start, orders) {
  const remaining = [...orders];
  const route = [];
  let current = start;
  while (remaining.length) {
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

function twoOpt(start, route) {
  if (route.length < 4) return route;
  let best = [...route], improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < best.length - 1; i++) {
      for (let j = i + 2; j < best.length; j++) {
        const candidate = [...best.slice(0,i+1), ...best.slice(i+1,j+1).reverse(), ...best.slice(j+1)];
        if (routeDistTotal(start, candidate) < routeDistTotal(start, best)) { best = candidate; improved = true; }
      }
    }
  }
  return best;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const body = req.method === 'POST'
      ? (typeof req.body === 'string' ? JSON.parse(req.body) : req.body) || {}
      : {};

    if (req.method === 'GET') return res.json({ technicians: TECHNICIANS });

    if (body.action === 'optimize') {
      const tech = TECHNICIANS.find(t => t.id === parseInt(body.techId));
      if (!tech) return res.status(400).json({ error: 'Techniker nicht gefunden' });

      const allOrders = (body.orders || []).filter(o => o.coords);
      if (!allOrders.length) return res.json({ tech, orders: [], outliers: [], totalDistance: 0, totalDuration: 0 });

      // Pipeline-Filter: nur terminierte Aufträge
      let pipelineStatus = {};
      try { pipelineStatus = require('../data/pipeline-status.json'); } catch {}
      let orders = allOrders;
      if (Object.keys(pipelineStatus).length > 0) {
        orders = orders.filter(o => pipelineStatus[o.id] === 'terminiert');
      }
      // Wenn keine terminierten → alle nehmen (Fallback für leere Pipeline)
      if (orders.length === 0 && Object.keys(pipelineStatus).length === 0) {
        // Kein Filter wenn Pipeline noch leer ist
        orders = allOrders;
      }

      // ── Ausreißer-Erkennung ──────────────────────────────────────
      // Schwellenwert: >50km Luftlinie vom Heimatort des Technikers
      const OUTLIER_KM = 50;

      const enriched = orders.map(o => {
        const distFromHome = Math.round(haversine(tech.home[0], tech.home[1], o.coords[0], o.coords[1]));
        const { tech: betterTech, dist: betterDist } = bestTechForOrder(o, TECHNICIANS.filter(t => t.id !== tech.id));
        return {
          ...o,
          distFromHome,
          isOutlier: distFromHome > OUTLIER_KM,
          betterTech: betterTech ? { id: betterTech.id, name: betterTech.name, dist: betterDist } : null,
        };
      });

      const outliers  = enriched.filter(o => o.isOutlier);
      const mainOrders = enriched.filter(o => !o.isOutlier);

      // Wenn alle Stops Ausreißer sind — trotzdem routen
      const ordersToRoute = mainOrders.length ? mainOrders : enriched;

      let route, totalDistance, totalDuration, routeGeometry, source = 'osrm';

      try {
        // OSRM: Home → alle Stops → Home (roundtrip=true, source=first)
        const coords = [tech.home, ...ordersToRoute.map(o => o.coords)];
        const osrm = await osrmTrip(coords);

        if (osrm.code !== 'Ok' || !osrm.trips?.[0]) throw new Error('OSRM: ' + (osrm.message || osrm.code));

        const trip = osrm.trips[0];

        // Waypoint-Mapping: waypoints[i].waypoint_index = Position im Trip für Input i
        const tripPositionToInput = new Array(osrm.waypoints.length);
        osrm.waypoints.forEach((wp, inputIdx) => {
          tripPositionToInput[wp.waypoint_index] = inputIdx;
        });
        // Position 0 = Startpunkt (home) → überspringen; -1 weil home auf inputIdx=0 war
        const waypointOrder = tripPositionToInput.slice(1).map(inputIdx => inputIdx - 1);
        route = waypointOrder.map(i => ordersToRoute[i]).filter(Boolean);

        totalDistance = Math.round(trip.distance / 100) / 10;
        totalDuration = Math.round(trip.duration);
        routeGeometry = trip.geometry?.coordinates || null;

      } catch (osrmErr) {
        console.warn('[routes] OSRM failed, fallback:', osrmErr.message);
        source = 'fallback';
        route = nearestNeighborRoute(tech.home, ordersToRoute);
        const dist = routeDistTotal(tech.home, route);
        totalDistance = Math.round(dist * 10) / 10;
        totalDuration = Math.round(dist / 50 * 3600);
        routeGeometry = null;
      }

      return res.json({
        tech: { id: tech.id, name: tech.name, home: tech.home, color: tech.color, city: tech.city },
        orders: route,
        outliers,
        totalDistance,
        totalDuration,
        routeGeometry,
        source,
      });
    }

    return res.status(400).json({ error: 'Nutze POST mit action=optimize.' });
  } catch (err) {
    console.error('[routes] Error:', err);
    res.status(500).json({ error: err.message });
  }
};
