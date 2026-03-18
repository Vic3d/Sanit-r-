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

// Nearest Neighbor TSP
function nearestNeighborRoute(start, orders) {
  const remaining = [...orders];
  const route = [];
  let current = start;
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

  if (route.length > 0) {
    totalDist += haversine(current[0], current[1], start[0], start[1]);
  }

  // Estimate duration: avg 50 km/h for SHK regional driving
  const durationSec = Math.round(totalDist / 50 * 3600);

  return { route, totalDistance: Math.round(totalDist * 10) / 10, totalDuration: durationSec };
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

      const orders = body.orders || [];
      if (!orders.length) return res.json({ tech, orders: [], totalDistance: 0, totalDuration: 0 });

      const { route, totalDistance, totalDuration } = nearestNeighborRoute(tech.home, orders);

      // Build straight-line geometry for map (Leaflet polyline)
      const routeGeometry = [tech.home, ...route.map(o => o.coords), tech.home];

      return res.json({
        tech: { id: tech.id, name: tech.name, home: tech.home, color: tech.color, city: tech.city },
        orders: route,
        totalDistance,
        totalDuration,
        routeGeometry,
      });
    }

    return res.status(400).json({ error: 'Nutze POST mit action=optimize.' });
  } catch (err) {
    console.error('[routes] Error:', err);
    res.status(500).json({ error: err.message });
  }
};
