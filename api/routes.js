const { getOrders } = require('./_lib/bohwk');

const ORS_KEY = process.env.ORS_API_KEY;
const ORS_BASE = 'https://api.openrouteservice.org';

const TECHNICIANS = [
  { id: 1, name: 'Nico Kussio', home: [8.3858, 51.9069], city: 'Gütersloh', color: '#3b82f6', boId: 158934 },
  { id: 2, name: 'Nico Walczak', home: [8.0011, 51.3279], city: 'Sundern', color: '#22c55e', boId: 158933 },
  { id: 3, name: 'Adem', home: [8.0011, 51.3279], city: 'Sundern', color: '#f59e0b', boId: 158932 },
  { id: 4, name: 'Ramiz', home: [7.8159, 51.6739], city: 'Hamm', color: '#ef4444', boId: 158931 },
];

// In-memory geocode cache
const geocodeCache = {};

async function fetchJSON(url, options = {}) {
  const res = await fetch(url, options);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ORS ${res.status}: ${text.substring(0, 200)}`);
  }
  return res.json();
}

async function geocodeAddress(address) {
  if (geocodeCache[address]) return geocodeCache[address];
  const url = `${ORS_BASE}/geocode/search?api_key=${ORS_KEY}&text=${encodeURIComponent(address)}&boundary.country=DE&size=1`;
  const data = await fetchJSON(url);
  if (data.features && data.features.length > 0) {
    const coords = data.features[0].geometry.coordinates; // [lng, lat]
    geocodeCache[address] = coords;
    return coords;
  }
  return null;
}

// Haversine distance in km
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

  if (!ORS_KEY) return res.status(500).json({ error: 'ORS_API_KEY nicht konfiguriert' });

  try {
    const reqBody = req.method === 'POST'
      ? (typeof req.body === 'string' ? JSON.parse(req.body) : req.body) || {}
      : {};
    const { techId, orderIds } = reqBody;

    // MODE 1: GET /api/routes — kept for backwards compat but frontend now uses DATA directly
    if (req.method === 'GET' && !orderIds) {
      return res.json({ technicians: TECHNICIANS, orders: [], note: 'Use POST action=geocode instead' });
    }

    // MODE 1b (unused now but kept): GET /api/routes — list all orders, geocode by PLZ only (fast!)
    if (req.method === 'GET' && !orderIds) {
      const orders = await getOrders();
      if (!orders.length) return res.json({ technicians: TECHNICIANS, orders: [] });

      // Collect unique PLZs
      const uniquePLZs = [...new Set(orders.map(o => o.Zipcode).filter(Boolean))];

      // Geocode unique PLZs only (much fewer calls than full addresses)
      const plzCoords = {};
      for (let i = 0; i < uniquePLZs.length; i++) {
        const plz = uniquePLZs[i];
        try {
          const coords = await geocodeAddress(`${plz}, Deutschland`);
          if (coords) plzCoords[plz] = coords;
        } catch (e) { /* skip */ }
        if (i < uniquePLZs.length - 1) await new Promise(r => setTimeout(r, 80));
      }

      // Build order list using PLZ coordinates
      const geocoded = [];
      const failed = [];
      for (let i = 0; i < orders.length; i++) {
        const o = orders[i];
        const coords = plzCoords[o.Zipcode];
        if (coords) {
          const distances = {};
          for (const t of TECHNICIANS) {
            distances[t.id] = Math.round(haversine(t.home[0], t.home[1], coords[0], coords[1]) * 10) / 10;
          }
          geocoded.push({
            id: o.ID?.SourceId || o.SourceId || `o${i}`,
            renter: o.Renter || '',
            street: o.Street || '',
            zipcode: o.Zipcode || '',
            city: o.City || '',
            telephone: o.Telephone || '',
            craft: o.Craft || '',
            disturbanceType: o.DisturbanceType || '',
            damage: o.Damage || '',
            remarks: o.Remarks || '',
            emergency: o.Emergency === 1,
            coords,
            distances,
          });
        } else {
          failed.push({ id: o.ID?.SourceId || '', renter: o.Renter || '', address: `${o.Street}, ${o.Zipcode} ${o.City}`, reason: 'PLZ nicht gefunden' });
        }
      }

      return res.json({ technicians: TECHNICIANS, orders: geocoded, failed, uniquePLZsGeocoded: Object.keys(plzCoords).length, computedAt: new Date().toISOString() });
    }

    // MODE 2a: POST /api/routes {action:'geocode', plzList:[...]} — geocode PLZs only
    const body = req.method === 'POST'
      ? (typeof req.body === 'string' ? JSON.parse(req.body) : req.body) || {}
      : {};

    if (req.method === 'POST' && body.action === 'geocode') {
      const plzList = body.plzList || [];
      const plzCoords = {};
      for (let i = 0; i < plzList.length; i++) {
        const plz = plzList[i];
        try {
          const coords = await geocodeAddress(`${plz}, Deutschland`);
          if (coords) plzCoords[plz] = coords;
        } catch (e) { /* skip */ }
        if (i < plzList.length - 1) await new Promise(r => setTimeout(r, 80));
      }
      return res.json({ plzCoords, count: Object.keys(plzCoords).length });
    }

    // MODE 2b: POST /api/routes — optimize route for selected tech + orders
    if (req.method === 'POST' && techId && orderIds) {
      const tid = parseInt(techId);
      const tech = TECHNICIANS.find(t => t.id === tid);
      if (!tech) return res.status(400).json({ error: 'Techniker nicht gefunden' });

      const ids = Array.isArray(orderIds) ? orderIds : orderIds.split(',');

      // Get all orders, filter selected
      const allOrders = await getOrders();
      const selected = [];
      for (const oid of ids) {
        const order = allOrders.find(o => String(o.ID?.SourceId) === String(oid) || String(o.SourceId) === String(oid));
        if (order) {
          const address = `${order.Street}, ${order.Zipcode} ${order.City}`;
          const coords = await geocodeAddress(address);
          if (coords) {
            selected.push({ order, coords, address });
          }
          if (!geocodeCache[address]) await new Promise(r => setTimeout(r, 80));
        }
      }

      if (!selected.length) return res.json({ tech, orders: [], totalDistance: 0, totalDuration: 0 });

      // ORS Optimization: 1 vehicle, N jobs
      const jobs = selected.map((item, idx) => ({
        id: idx + 1,
        location: item.coords,
      }));

      const optBody = {
        jobs,
        vehicles: [{
          id: 1,
          start: tech.home,
          end: tech.home,
          profile: 'driving-car',
        }],
      };

      const optResult = await fetchJSON(`${ORS_BASE}/optimization`, {
        method: 'POST',
        headers: { 'Authorization': ORS_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify(optBody),
      });

      // Build ordered result from optimization steps
      const route = optResult.routes?.[0];
      const orderedOrders = [];
      let totalDistance = 0;
      let totalDuration = 0;

      if (route) {
        totalDistance = Math.round((route.distance || 0) / 1000 * 10) / 10;
        totalDuration = route.duration || 0;

        for (const step of route.steps || []) {
          if (step.type === 'job') {
            const item = selected[step.id - 1];
            if (item) {
              const o = item.order;
              orderedOrders.push({
                id: o.ID?.SourceId || o.SourceId || '',
                renter: o.Renter || '',
                street: o.Street || '',
                zipcode: o.Zipcode || '',
                city: o.City || '',
                telephone: o.Telephone || '',
                craft: o.Craft || '',
                disturbanceType: o.DisturbanceType || '',
                emergency: o.Emergency === 1,
                coords: item.coords,
              });
            }
          }
        }
      }

      // Get ORS directions for the actual road route (polyline)
      let routeGeometry = null;
      if (orderedOrders.length > 0) {
        try {
          const waypoints = [tech.home, ...orderedOrders.map(o => o.coords), tech.home];
          const dirResult = await fetchJSON(`${ORS_BASE}/v2/directions/driving-car/geojson`, {
            method: 'POST',
            headers: { 'Authorization': ORS_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({ coordinates: waypoints }),
          });
          if (dirResult.features?.[0]?.geometry) {
            routeGeometry = dirResult.features[0].geometry.coordinates; // [[lng,lat], ...]
          }
        } catch (e) {
          console.warn('[routes] Directions fallback to straight lines:', e.message);
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

    return res.status(400).json({ error: 'Ungültiger Request. GET für Aufträge, POST mit techId+orderIds für Route.' });
  } catch (err) {
    console.error('[routes] Error:', err);
    res.status(500).json({ error: err.message });
  }
};
