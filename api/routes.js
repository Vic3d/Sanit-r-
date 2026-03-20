/**
 * routes.js — Routenoptimierung für Gebr. Schutzeichel
 *
 * Pipeline:
 *  1. Geocoding: Straßenadresse → echte [lon,lat] (Nominatim, gecacht)
 *  2. Outlier-Erkennung: Aufträge >50km vom Heimatort → separates Panel
 *  3. OSRM Trip API: echte Straßenroute (roundtrip Heimat→Stops→Heimat)
 *  4. Fallback: Nearest Neighbor + 2-opt (wenn OSRM nicht verfügbar)
 */

const https    = require('https');
const { geocodeBatch } = require('./_lib/geocoder');
const ors      = require('./_lib/ors');

const TECHNICIANS = [
  { id: 1, name: 'Nico Kussio',  home: [8.3858, 51.9069], city: 'Gütersloh', color: '#3b82f6', boId: 158934 },
  { id: 2, name: 'Nico Walczak', home: [8.0011, 51.3279], city: 'Sundern',   color: '#22c55e', boId: 158933 },
  { id: 3, name: 'Adem',         home: [8.0011, 51.3279], city: 'Sundern',   color: '#f59e0b', boId: 158932 },
  { id: 4, name: 'Ramiz',        home: [7.8159, 51.6739], city: 'Hamm',      color: '#ef4444', boId: 158931 },
];

// ── Haversine (Luftlinie, Fallback-Distanzberechnung) ─────────────────────────
function haversine(lon1, lat1, lon2, lat2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// Welcher Monteur liegt am nächsten (für Ausreißer-Vorschlag)?
function bestTechForOrder(order, allTechs) {
  let best = null, bestDist = Infinity;
  for (const t of allTechs) {
    const d = haversine(t.home[0], t.home[1], order.coords[0], order.coords[1]);
    if (d < bestDist) { bestDist = d; best = t; }
  }
  return { tech: best, dist: Math.round(bestDist) };
}

// ── OSRM Trip API (echte Straßenoptimierung) ──────────────────────────────────
function osrmTrip(coords) {
  const coordStr = coords.map(c => `${c[0]},${c[1]}`).join(';');
  // source=first: Heimatort ist immer erster Stop
  // destination=last: Heimatrückkehr am Ende
  // roundtrip=true: geschlossene Route
  const path = `/trip/v1/driving/${coordStr}?roundtrip=true&source=first&destination=last&annotations=duration,distance&geometries=geojson`;
  return new Promise((resolve, reject) => {
    const req = https.get(
      { hostname: 'router.project-osrm.org', path, headers: { 'User-Agent': 'JoshDashboard/1.0' } },
      (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch { reject(new Error('OSRM parse error')); }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('OSRM timeout')); });
  });
}

// ── Fallback: Nearest Neighbor + 2-opt ───────────────────────────────────────
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

// ── Auftragsdauer-Schätzung nach Gewerk/Störungstyp ──────────────────────────
// Gibt geschätzte Einsatzdauer in Sekunden zurück
function estimateJobDuration(order) {
  const craft = (order.craft || '').toLowerCase();
  const dist  = (order.disturbanceType || order.damage || '').toLowerCase();
  const text  = craft + ' ' + dist;

  if (order.emergency)                          return 7200;  // Notfall: 2h
  if (text.includes('bad') || text.includes('installation')) return 10800; // Bad/Installation: 3h
  if (text.includes('heizung') || text.includes('thermostat')) return 2700; // Heizung: 45min
  if (text.includes('rohr') || text.includes('leck'))          return 3600; // Rohrbruch: 1h
  if (text.includes('wc') || text.includes('dusche'))          return 2700; // WC/Dusche: 45min
  if (text.includes('wartung') || text.includes('service'))    return 3600; // Wartung: 1h
  return 3600; // Default: 1h
}

// ── Main Handler ──────────────────────────────────────────────────────────────
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

    // GET: Techniker-Liste zurückgeben
    if (req.method === 'GET') return res.json({ technicians: TECHNICIANS });

    if (body.action === 'optimize') {
      const tech = TECHNICIANS.find(t => t.id === parseInt(body.techId));
      if (!tech) return res.status(400).json({ error: 'Techniker nicht gefunden' });

      const allOrders = (body.orders || []).filter(o => o.coords || (o.street && o.zipcode));
      if (!allOrders.length) return res.json({ tech, orders: [], outliers: [], totalDistance: 0, totalDuration: 0 });

      // Pipeline-Filter: nur terminierte Aufträge (wenn Pipeline befüllt)
      let pipelineStatus = {};
      try { pipelineStatus = require('../data/pipeline-status.json'); } catch {}
      let orders = allOrders;
      if (Object.keys(pipelineStatus).length > 0) {
        const filtered = orders.filter(o => pipelineStatus[o.id] === 'terminiert');
        if (filtered.length > 0) orders = filtered;
      }

      // ── SCHRITT 1: Echte Straßenkoordinaten per Nominatim ──────────────────
      // geocodeBatch überschreibt PLZ-Koordinaten mit echten Straßen-Koordinaten.
      // Timeout 15s → danach PLZ-Fallback für restliche Adressen.
      // Cache: in-memory (warm Lambda), Cache-Hit = kein API-Call.
      console.log(`[routes] Geocoding ${orders.length} Adressen…`);
      const geocodedCoords = await geocodeBatch(
        orders,
        {},       // kein PLZ-Fallback von hier — coords kommen schon vom Frontend
        15000     // 15s Gesamt-Timeout
      );
      orders = orders.map((o, i) => ({
        ...o,
        coords: geocodedCoords[i] || o.coords, // Real coords überschreiben PLZ-Zentrum
      }));

      // ── SCHRITT 2: Notfälle priorisieren ───────────────────────────────────
      // Notfall-Aufträge kommen zuerst in den OSRM-Input → werden als erste Stops geplant
      const emergencies = orders.filter(o => o.emergency && o.coords);
      const normals     = orders.filter(o => !o.emergency && o.coords);
      orders = [...emergencies, ...normals];

      // ── SCHRITT 3: Ausreißer-Erkennung (>50km Luftlinie vom Heimatort) ─────
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

      const outliers    = enriched.filter(o => o.isOutlier);
      const mainOrders  = enriched.filter(o => !o.isOutlier);
      const ordersToRoute = mainOrders.length ? mainOrders : enriched;

      // ── SCHRITT 4: Routenoptimierung ────────────────────────────────────────
      // Reihenfolge: ORS (wenn API Key gesetzt) → OSRM Public → Nearest Neighbor Fallback
      let route, totalDistance, totalDuration, routeGeometry, source = 'osrm';

      const routeCoords = [tech.home, ...ordersToRoute.map(o => o.coords)];

      // ── Versuch 1: OpenRouteService (wenn ORS_API_KEY in Env) ──────────────
      if (ors.isAvailable()) {
        try {
          const jobs = ordersToRoute.map((o, i) => ({
            id: i,
            location: o.coords,
            service: estimateJobDuration(o), // Schätzung pro Auftragstyp (Sekunden)
          }));
          const result = await ors.orsOptimize({ start: tech.home, end: tech.home }, jobs);
          route         = result.route;
          totalDistance = result.distance_m ? Math.round(result.distance_m / 100) / 10 : null;
          totalDuration = result.duration_s || null;
          routeGeometry = result.geometry   || null;
          source        = 'ors';
          console.log(`[routes] ORS Optimization: ${route.length} Stops, ${totalDistance}km`);
        } catch (orsErr) {
          console.warn('[routes] ORS failed, versuche OSRM:', orsErr.message);
        }
      }

      // ── Versuch 2: OSRM Trip API (Public Server) ───────────────────────────
      if (!route) {
        try {
          const osrm = await osrmTrip(routeCoords);
          if (osrm.code !== 'Ok' || !osrm.trips?.[0]) throw new Error('OSRM: ' + (osrm.message || osrm.code));

          const trip = osrm.trips[0];

          // Waypoint-Mapping: waypoints[i].waypoint_index = Position im optimierten Trip
          const waypointOrder = new Array(ordersToRoute.length);
          osrm.waypoints.forEach((wp, inputIdx) => {
            if (inputIdx === 0) return; // Heimatort überspringen
            waypointOrder[wp.waypoint_index - 1] = inputIdx - 1;
          });
          route = waypointOrder.filter(i => i !== undefined).map(i => ordersToRoute[i]).filter(Boolean);

          // Sicherheitsnetz: fehlende Stops ans Ende
          const routedIds = new Set(route.map(o => o.id));
          ordersToRoute.filter(o => !routedIds.has(o.id)).forEach(o => route.push(o));

          totalDistance = Math.round(trip.distance / 100) / 10;
          totalDuration = Math.round(trip.duration);
          routeGeometry = trip.geometry?.coordinates || null;
          source        = 'osrm';
        } catch (osrmErr) {
          console.warn('[routes] OSRM failed, Nearest Neighbor Fallback:', osrmErr.message);
        }
      }

      // ── Fallback: Nearest Neighbor + 2-opt (keine externe API) ────────────
      if (!route) {
        source        = 'fallback';
        route         = nearestNeighborRoute(tech.home, ordersToRoute);
        const dist    = routeDistTotal(tech.home, route);
        totalDistance = Math.round(dist * 10) / 10;
        totalDuration = Math.round(dist / 50 * 3600); // ~50 km/h Durchschnitt
        routeGeometry = null;
      }

      return res.json({
        tech:          { id: tech.id, name: tech.name, home: tech.home, color: tech.color, city: tech.city },
        orders:        route,
        outliers,
        totalDistance,
        totalDuration,
        routeGeometry,
        source,
        geocoderStats: { cacheSize: require('./_lib/geocoder').cacheSize() },
      });
    }

    return res.status(400).json({ error: 'Nutze POST mit action=optimize.' });
  } catch (err) {
    console.error('[routes] Error:', err);
    res.status(500).json({ error: err.message });
  }
};
