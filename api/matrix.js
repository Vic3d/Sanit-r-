/**
 * matrix.js — Echte Straßendistanzen via OSRM Table API
 *
 * Ersetzt haversineKm() im Frontend durch echte Fahrstrecken.
 * OSRM /table/v1/driving/ berechnet in einem Call:
 *   4 Techniker × N Aufträge = 4×N Distanz-Matrix
 *
 * Wird lazy geladen wenn Route-Tab geöffnet wird (nicht beim Page-Load).
 *
 * POST /api/matrix
 * Body: { orders: [{id, coords: [lon, lat]}] }
 * Response: { matrix: { orderId: { techId: { distance_km, duration_min } } } }
 */

const https = require('https');

const TECHNICIANS = [
  { id: 1, name: 'Nico Kussio',  home: [8.3858, 51.9069] },
  { id: 2, name: 'Nico Walczak', home: [8.0011, 51.3279] },
  { id: 3, name: 'Adem',         home: [8.0011, 51.3279] },
  { id: 4, name: 'Ramiz',        home: [7.8159, 51.6739] },
];

// Modul-Level Cache: {coordsKey → {distances, durations}}
const _matrixCache = new Map();

/**
 * OSRM Table API Call
 * sources = Techniker (Index 0..3)
 * destinations = Aufträge (Index 4..N)
 */
function osrmTable(allCoords, numSources) {
  const coordStr  = allCoords.map(c => `${c[0]},${c[1]}`).join(';');
  const sourceIdx = Array.from({ length: numSources }, (_, i) => i).join(',');
  const destIdx   = Array.from({ length: allCoords.length - numSources }, (_, i) => i + numSources).join(',');
  const path = `/table/v1/driving/${coordStr}?sources=${sourceIdx}&destinations=${destIdx}&annotations=distance,duration`;

  return new Promise((resolve, reject) => {
    const req = https.get(
      { hostname: 'router.project-osrm.org', path, headers: { 'User-Agent': 'JoshDashboard/1.0' } },
      (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch { reject(new Error('OSRM Table parse error')); }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('OSRM Table timeout')); });
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    const orders = (body.orders || []).filter(o => o.id && o.coords && o.coords.length === 2);

    if (!orders.length) return res.json({ matrix: {}, cached: false });

    // Cache-Key: alle Order-Koordinaten als String
    const cacheKey = orders.map(o => `${o.coords[0].toFixed(4)},${o.coords[1].toFixed(4)}`).join('|');
    if (_matrixCache.has(cacheKey)) {
      const cached = _matrixCache.get(cacheKey);
      return res.json({ matrix: cached, cached: true, cacheSize: _matrixCache.size });
    }

    // OSRM Table: [tech0_home, tech1_home, tech2_home, tech3_home, order0, order1, ...]
    const techCoords  = TECHNICIANS.map(t => t.home);
    const orderCoords = orders.map(o => o.coords);
    const allCoords   = [...techCoords, ...orderCoords];

    const result = await osrmTable(allCoords, techCoords.length);

    if (result.code !== 'Ok') {
      throw new Error('OSRM Table: ' + (result.message || result.code));
    }

    // distances_matrix[sourceIdx][destIdx] = Meter
    // durations_matrix[sourceIdx][destIdx] = Sekunden
    const distMatrix = result.distances  || [];
    const durMatrix  = result.durations  || [];

    // Umformen: {orderId: {techId: {distance_km, duration_min}}}
    const matrix = {};
    orders.forEach((order, orderIdx) => {
      matrix[order.id] = {};
      TECHNICIANS.forEach((tech, techIdx) => {
        const distM = distMatrix[techIdx]?.[orderIdx];
        const durS  = durMatrix[techIdx]?.[orderIdx];
        matrix[order.id][tech.id] = {
          distance_km:   distM != null ? Math.round(distM / 100) / 10 : null,  // m → km (1 Nachkommastelle)
          duration_min:  durS  != null ? Math.round(durS / 60)          : null,  // s → min
        };
      });
    });

    _matrixCache.set(cacheKey, matrix);

    console.log(`[matrix] ${orders.length} Aufträge × ${TECHNICIANS.length} Techs = ${orders.length * TECHNICIANS.length} Paare berechnet`);
    return res.json({ matrix, cached: false, cacheSize: _matrixCache.size });

  } catch (err) {
    console.error('[matrix] Error:', err.message);
    // Graceful degradation: leere Matrix zurück → Frontend nutzt Haversine-Fallback
    return res.status(500).json({ error: err.message, matrix: {} });
  }
};
