const { getOrders } = require('./_lib/bohwk');

const ORS_KEY = process.env.ORS_API_KEY;
const ORS_BASE = 'https://api.openrouteservice.org';

const TECHNICIANS = [
  { id: 1, name: 'Nico Kussio', home: [8.3858, 51.9069], color: '#3b82f6', boId: 158934 },
  { id: 2, name: 'Nico Walczak', home: [8.0011, 51.3279], color: '#22c55e', boId: 158933 },
  { id: 3, name: 'Adem', home: [8.0011, 51.3279], color: '#f59e0b', boId: 158932 },
  { id: 4, name: 'Ramiz', home: [7.8159, 51.6739], color: '#ef4444', boId: 158931 },
];

// Simple in-memory geocode cache (survives within lambda instance)
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

async function geocodeWithDelay(orders) {
  const results = [];
  const unassigned = [];

  for (let i = 0; i < orders.length; i++) {
    const o = orders[i];
    const address = `${o.Street}, ${o.Zipcode} ${o.City}`;
    try {
      const coords = await geocodeAddress(address);
      if (coords) {
        results.push({ order: o, coords, address });
      } else {
        unassigned.push({ order: o, reason: 'Geocoding fehlgeschlagen', address });
      }
    } catch (err) {
      unassigned.push({ order: o, reason: err.message, address });
    }

    // Rate limit: max 40/min → ~67ms between requests, use 80ms to be safe
    // Only delay if not cached
    if (!geocodeCache[address] && i < orders.length - 1) {
      await new Promise(r => setTimeout(r, 80));
    }
  }

  return { results, unassigned };
}

async function optimizeRoutes(geocodedOrders) {
  const jobs = geocodedOrders.map((item, idx) => ({
    id: idx + 1,
    location: item.coords,
    description: item.address,
  }));

  const vehicles = TECHNICIANS.map(t => ({
    id: t.id,
    start: t.home,
    end: t.home, // return home
    profile: 'driving-car',
    description: t.name,
  }));

  const body = { jobs, vehicles };

  const data = await fetchJSON(`${ORS_BASE}/optimization`, {
    method: 'POST',
    headers: {
      'Authorization': ORS_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  return data;
}

function buildResponse(optimization, geocodedOrders, unassigned) {
  const techResults = TECHNICIANS.map(tech => {
    const route = optimization.routes?.find(r => r.vehicle === tech.id);
    const orders = [];
    let totalDistance = 0;
    let totalDuration = 0;
    let routeCoords = [];

    if (route) {
      totalDistance = Math.round((route.distance || 0) / 1000 * 10) / 10; // km
      totalDuration = route.duration || 0; // seconds

      // Extract route geometry if available
      if (route.geometry) {
        // ORS returns encoded polyline — we'll decode on frontend or skip
        routeCoords = [];
      }

      // Steps contain the ordered jobs
      for (const step of route.steps || []) {
        if (step.type === 'job') {
          const jobIdx = step.id - 1;
          const item = geocodedOrders[jobIdx];
          if (item) {
            const o = item.order;
            orders.push({
              sourceId: o.ID?.SourceId || o.SourceId || '',
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
              coords: item.coords,
              arrival: step.arrival || 0,
              duration: step.duration || 0,
              distance: step.distance || 0,
              waiting_time: step.waiting_time || 0,
            });
          }
        }
      }
    }

    return {
      id: tech.id,
      name: tech.name,
      home: tech.home,
      color: tech.color,
      boId: tech.boId,
      orders,
      totalDistance,
      totalDuration,
    };
  });

  // Add unassigned from optimization
  const optUnassigned = (optimization.unassigned || []).map(u => {
    const item = geocodedOrders[u.id - 1];
    return item ? {
      order: {
        sourceId: item.order.ID?.SourceId || '',
        renter: item.order.Renter || '',
        address: item.address,
      },
      reason: 'Nicht zuweisbar (Optimierung)',
    } : null;
  }).filter(Boolean);

  return {
    technicians: techResults,
    unassigned: [
      ...unassigned.map(u => ({
        sourceId: u.order.ID?.SourceId || '',
        renter: u.order.Renter || '',
        address: u.address,
        reason: u.reason,
      })),
      ...optUnassigned,
    ],
    summary: {
      totalOrders: geocodedOrders.length + unassigned.length,
      assigned: geocodedOrders.length - (optimization.unassigned?.length || 0),
      unassignedCount: unassigned.length + (optimization.unassigned?.length || 0),
      computedAt: new Date().toISOString(),
    },
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!ORS_KEY) {
    return res.status(500).json({ error: 'ORS_API_KEY nicht konfiguriert' });
  }

  try {
    // 1. Get orders from B&O
    const orders = await getOrders();
    if (!orders.length) {
      return res.json({
        technicians: TECHNICIANS.map(t => ({ ...t, orders: [], totalDistance: 0, totalDuration: 0 })),
        unassigned: [],
        summary: { totalOrders: 0, assigned: 0, unassignedCount: 0, computedAt: new Date().toISOString() },
      });
    }

    // 2. Geocode all addresses
    const { results: geocodedOrders, unassigned } = await geocodeWithDelay(orders);

    if (!geocodedOrders.length) {
      return res.json({
        technicians: TECHNICIANS.map(t => ({ ...t, orders: [], totalDistance: 0, totalDuration: 0 })),
        unassigned: unassigned.map(u => ({
          sourceId: u.order.ID?.SourceId || '',
          renter: u.order.Renter || '',
          address: u.address,
          reason: u.reason,
        })),
        summary: { totalOrders: orders.length, assigned: 0, unassignedCount: orders.length, computedAt: new Date().toISOString() },
      });
    }

    // 3. Optimize routes via ORS
    const optimization = await optimizeRoutes(geocodedOrders);

    // 4. Build and return response
    const response = buildResponse(optimization, geocodedOrders, unassigned);
    res.json(response);
  } catch (err) {
    console.error('[routes] Error:', err);
    res.status(500).json({ error: err.message });
  }
};
