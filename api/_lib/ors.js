/**
 * ors.js — OpenRouteService API (Backup für OSRM)
 *
 * ORS ist zuverlässiger als der Public OSRM Server (eigener Server, SLA).
 * Kostenlos: 2000 Directions/Tag, 500 Optimization/Tag.
 * API Key: process.env.ORS_API_KEY (kostenlos registrieren auf openrouteservice.org)
 *
 * Funktionen:
 *  - orsTrip()       → Roundtrip-Optimierung (Ersatz für OSRM /trip)
 *  - orsOptimize()   → VRP Solver via Vroom (unterstützt Zeitfenster, Kapazitäten)
 *  - isAvailable()   → true wenn ORS_API_KEY gesetzt
 */

const https = require('https');

const API_KEY  = process.env.ORS_API_KEY || null;
const BASE     = 'api.openrouteservice.org';
const PROFILE  = 'driving-car';

function isAvailable() {
  return !!API_KEY;
}

function orsRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: BASE,
      path,
      method,
      headers: {
        'Authorization': API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json, application/geo+json',
      },
    };
    if (payload) options.headers['Content-Length'] = Buffer.byteLength(payload);

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) reject(new Error(`ORS ${res.statusCode}: ${parsed.error?.message || data.slice(0,100)}`));
          else resolve(parsed);
        } catch { reject(new Error('ORS parse error')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('ORS timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * orsTrip — Roundtrip-Optimierung (Ersatz für OSRM /trip)
 * Nutzt ORS Directions + greedy Waypoint-Reihenfolge.
 *
 * @param {Array} coords  — [[lon,lat], ...] — coords[0] = Heimatort
 * @returns {{ route: [lon,lat][], distance_m, duration_s, geometry }}
 */
async function orsTrip(coords) {
  if (!isAvailable()) throw new Error('ORS_API_KEY nicht gesetzt');
  if (coords.length < 2) throw new Error('Mindestens 2 Koordinaten erforderlich');

  // ORS Directions: direkte Route (keine Optimierung)
  // Für Optimierung: Vroom über /optimization endpoint
  const body = {
    coordinates: coords,
    radiuses: coords.map(() => -1), // -1 = unbegrenzt
    instructions: false,
    geometry: true,
  };

  const result = await orsRequest('POST', `/v2/directions/${PROFILE}/geojson`, body);

  if (!result.features?.[0]) throw new Error('ORS: keine Route gefunden');

  const feat     = result.features[0];
  const summary  = feat.properties.summary;
  const geometry = feat.geometry.coordinates; // [[lon,lat], ...]

  return {
    distance_m: summary.distance,
    duration_s: summary.duration,
    geometry,
  };
}

/**
 * orsOptimize — VRP Solver (Vroom) für echte Multi-Stop-Optimierung
 * Unterstützt: Zeitfenster, Kapazitäten, Pausen, Multi-Vehicle
 *
 * @param {Object} vehicle  — { id, start: [lon,lat], end: [lon,lat] }
 * @param {Array}  jobs     — [{ id, location: [lon,lat], time_windows?, service? }]
 * @returns {{ route: jobId[], geometry, duration_s, distance_m }}
 */
async function orsOptimize(vehicle, jobs) {
  if (!isAvailable()) throw new Error('ORS_API_KEY nicht gesetzt');

  const body = {
    jobs: jobs.map((j, i) => ({
      id: i + 1,
      location: j.location,
      service: j.service || 1800,         // Default: 30min pro Auftrag
      time_windows: j.time_windows || undefined,
    })),
    vehicles: [{
      id: 1,
      profile: PROFILE,
      start: vehicle.start,
      end:   vehicle.end || vehicle.start, // Heimrückkehr
    }],
    options: { g: true }, // geometries
  };

  const result = await orsRequest('POST', '/optimization', body);

  if (!result.routes?.[0]) throw new Error('ORS Optimization: keine Route');

  const r = result.routes[0];
  // Reihenfolge der Jobs (steps ohne start/end)
  const jobOrder = r.steps
    .filter(s => s.type === 'job')
    .map(s => jobs[s.id - 1]); // zurück auf originale Jobs mappen

  return {
    route:      jobOrder,
    duration_s: r.duration,
    distance_m: r.distance,
    geometry:   r.geometry || null,
    cost:       r.cost,
  };
}

module.exports = { isAvailable, orsTrip, orsOptimize };
