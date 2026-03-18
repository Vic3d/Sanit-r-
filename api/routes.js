const ORS_KEY = process.env.ORS_API_KEY;
const ORS_BASE = 'https://api.openrouteservice.org';

const TECHNICIANS = [
  { id: 1, name: 'Nico Kussio', home: [8.3858, 51.9069], city: 'Gütersloh', color: '#3b82f6', boId: 158934 },
  { id: 2, name: 'Nico Walczak', home: [8.0011, 51.3279], city: 'Sundern', color: '#22c55e', boId: 158933 },
  { id: 3, name: 'Adem', home: [8.0011, 51.3279], city: 'Sundern', color: '#f59e0b', boId: 158932 },
  { id: 4, name: 'Ramiz', home: [7.8159, 51.6739], city: 'Hamm', color: '#ef4444', boId: 158931 },
];

// Haversine distance in km
function haversine(lon1, lat1, lon2, lat2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// Nearest Neighbor TSP: start → closest unvisited → ... → end
function nearestNeighborRoute(start, orders) {
  const remaining = [...orders];
  const route = [];
  let current = start; // [lng, lat]
  let totalDist = 0;

  while (remaining.length > 0) {
    let bestIdx = 0, bestDist = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = haversine(current[0], current[1], remaining[i].coords[0], remaining[i].coords[1]);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    const next = remaining.splice(bestIdx, 1)[0];
    totalDist += bestDist;
    route.push(next);
    current = next.coords;
  }

  // Add return to start
  if (route.length > 0) {
    totalDist += haversine(current[0], current[1], start[0], start[1]);
  }

  return { route, totalDistance: Math.round(totalDist * 10) / 10 };
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

    // POST action=optimize → Nearest Neighbor + ORS Directions
    if (body.action === 'optimize') {
      const tech = TECHNICIANS.find(t => t.id === parseInt(body.techId));
      if (!tech) return res.status(400).json({ error: 'Techniker nicht gefunden' });

      const orders = body.orders || [];
      if (!orders.length) return res.json({ tech, orders: [], totalDistance: 0, totalDuration: 0 });

      // Step 1: Nearest Neighbor sort (instant, no API)
      const { route: orderedOrders, totalDistance } = nearestNeighborRoute(tech.home, orders);

      // Step 2: Get actual road route via ORS Directions (this works with the key!)
      let routeGeometry = null;
      let realDistance = totalDistance; // fallback to Haversine
      let realDuration = 0;

      if (ORS_KEY && orderedOrders.length > 0) {
        try {
          const waypoints = [tech.home, ...orderedOrders.map(o => o.coords), tech.home];
          console.log('[routes] ORS Directions request:', waypoints.length, 'waypoints, key:', ORS_KEY.substring(0, 15) + '...');
          const dirRes = await fetch(`${ORS_BASE}/v2/directions/driving-car/geojson`, {
            method: 'POST',
            headers: { 'Authorization': ORS_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({ coordinates: waypoints }),
          });
          const dirText = await dirRes.text();
          global._lastOrsStatus = dirRes.status;
          global._lastOrsBody = dirText.substring(0, 300);
          console.log('[routes] ORS response:', dirRes.status, dirText.substring(0, 200));
          if (dirRes.ok) {
            const dirData = JSON.parse(dirText);
            const feature = dirData.features?.[0];
            if (feature) {
              routeGeometry = feature.geometry?.coordinates;
              const summary = feature.properties?.summary;
              if (summary) {
                realDistance = Math.round((summary.distance || 0) / 1000 * 10) / 10;
                realDuration = Math.round(summary.duration || 0);
              }
            }
          }
        } catch (e) {
          console.warn('[routes] ORS Directions failed:', e.message);
        }
      }

      return res.json({
        tech: { id: tech.id, name: tech.name, home: tech.home, color: tech.color, city: tech.city },
        orders: orderedOrders,
        totalDistance: realDistance,
        totalDuration: realDuration,
        routeGeometry,
        _debug: { hasKey: !!ORS_KEY, keyStart: ORS_KEY ? ORS_KEY.substring(0, 10) : 'MISSING', waypointCount: orderedOrders.length + 2, orsStatus: global._lastOrsStatus || 'unknown', orsBody: global._lastOrsBody || '' },
      });
    }

    return res.status(400).json({ error: 'Nutze POST mit action=optimize.' });
  } catch (err) {
    console.error('[routes] Error:', err);
    res.status(500).json({ error: err.message });
  }
};
