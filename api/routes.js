const ORS_KEY = process.env.ORS_API_KEY;
const ORS_BASE = 'https://api.openrouteservice.org';

const TECHNICIANS = [
  { id: 1, name: 'Nico Kussio', home: [8.3858, 51.9069], city: 'Gütersloh', color: '#3b82f6', boId: 158934 },
  { id: 2, name: 'Nico Walczak', home: [8.0011, 51.3279], city: 'Sundern', color: '#22c55e', boId: 158933 },
  { id: 3, name: 'Adem', home: [8.0011, 51.3279], city: 'Sundern', color: '#f59e0b', boId: 158932 },
  { id: 4, name: 'Ramiz', home: [7.8159, 51.6739], city: 'Hamm', color: '#ef4444', boId: 158931 },
];

const geocodeCache = {};

async function nominatimGeocode(query) {
  if (geocodeCache[query]) return geocodeCache[query];
  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&countrycodes=de&limit=1`;
  const res = await fetch(url, { headers: { 'User-Agent': 'SchutzeichelDashboard/1.0' } });
  if (!res.ok) throw new Error(`Nominatim ${res.status}`);
  const data = await res.json();
  if (data && data.length > 0) {
    const coords = [parseFloat(data[0].lon), parseFloat(data[0].lat)];
    geocodeCache[query] = coords;
    return coords;
  }
  return null;
}

async function orsRequest(path, body) {
  const res = await fetch(`${ORS_BASE}${path}`, {
    method: 'POST',
    headers: { 'Authorization': ORS_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ORS ${res.status}: ${text.substring(0, 200)}`);
  }
  return res.json();
}

function haversine(lon1, lat1, lon2, lat2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
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

    // GET → return technicians info only
    if (req.method === 'GET') {
      return res.json({ technicians: TECHNICIANS });
    }

    // POST action=geocode → geocode PLZ list via Nominatim (FREE)
    if (body.action === 'geocode') {
      const plzList = body.plzList || [];
      const plzCoords = {};
      const errors = [];
      for (let i = 0; i < plzList.length; i++) {
        const plz = plzList[i];
        try {
          const coords = await nominatimGeocode(`${plz}, Deutschland`);
          if (coords) plzCoords[plz] = coords;
          else errors.push({ plz, error: 'nicht gefunden' });
        } catch (e) {
          errors.push({ plz, error: e.message });
        }
        // Nominatim: max 1 req/sec
        if (i < plzList.length - 1) await new Promise(r => setTimeout(r, 1100));
      }
      return res.json({ plzCoords, count: Object.keys(plzCoords).length, requested: plzList.length, errors: errors.slice(0, 5) });
    }

    // POST action=optimize → optimize route for 1 tech + selected order coords
    if (body.action === 'optimize') {
      if (!ORS_KEY) return res.status(500).json({ error: 'ORS_API_KEY nicht konfiguriert' });

      const tech = TECHNICIANS.find(t => t.id === parseInt(body.techId));
      if (!tech) return res.status(400).json({ error: 'Techniker nicht gefunden' });

      // orders = [{id, coords:[lng,lat], ...}]
      const orders = body.orders || [];
      if (!orders.length) return res.json({ tech, orders: [], totalDistance: 0, totalDuration: 0 });

      // ORS Optimization
      const jobs = orders.map((o, idx) => ({ id: idx + 1, location: o.coords }));
      const optResult = await orsRequest('/optimization', {
        jobs,
        vehicles: [{ id: 1, start: tech.home, end: tech.home, profile: 'driving-car' }],
      });

      const route = optResult.routes?.[0];
      const orderedOrders = [];
      let totalDistance = 0, totalDuration = 0;

      if (route) {
        totalDistance = Math.round((route.distance || 0) / 1000 * 10) / 10;
        totalDuration = route.duration || 0;
        for (const step of route.steps || []) {
          if (step.type === 'job') {
            const orig = orders[step.id - 1];
            if (orig) orderedOrders.push(orig);
          }
        }
      }

      // Get road geometry
      let routeGeometry = null;
      if (orderedOrders.length > 0) {
        try {
          const waypoints = [tech.home, ...orderedOrders.map(o => o.coords), tech.home];
          const dirResult = await orsRequest('/v2/directions/driving-car/geojson', { coordinates: waypoints });
          if (dirResult.features?.[0]?.geometry) {
            routeGeometry = dirResult.features[0].geometry.coordinates;
          }
        } catch (e) {
          console.warn('[routes] Directions fallback:', e.message);
        }
      }

      return res.json({
        tech: { id: tech.id, name: tech.name, home: tech.home, color: tech.color, city: tech.city },
        orders: orderedOrders,
        totalDistance,
        totalDuration,
        routeGeometry,
      });
    }

    return res.status(400).json({ error: 'Ungültig. Nutze action=geocode oder action=optimize.' });
  } catch (err) {
    console.error('[routes] Error:', err);
    res.status(500).json({ error: err.message });
  }
};
