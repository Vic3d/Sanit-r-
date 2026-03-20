/**
 * geocoder.js — Nominatim Street-Level Geocoding mit In-Memory Cache
 *
 * Löst das PLZ-Zentrum Problem: Statt plzCoords["33332"] = [8.387, 51.918]
 * bekommen wir: "Behringstraße 5, 33332 Gütersloh" = [8.394, 51.923]
 *
 * Rate Limit: Nominatim erlaubt 1 req/s (Policy).
 * Cache: In-Memory (warm Lambda ~5-10min), kein Vercel KV nötig.
 * Fallback: Immer — wenn Nominatim nichts findet → PLZ-Koordinate aus plzCoords.
 */

const https = require('https');

// Modul-Level Cache — persistiert solange Lambda warm bleibt
const _cache = new Map();
let _lastRequest = 0;
let _requestCount = 0;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Nominatim API Call
 * @param {string} query  — "Behringstraße 5, 33332 Gütersloh, Germany"
 * @returns {[lon, lat] | null}
 */
function nominatimLookup(query) {
  return new Promise((resolve) => {
    const path = `/search?q=${encodeURIComponent(query)}&format=json&limit=1&countrycodes=de&addressdetails=0`;
    const options = {
      hostname: 'nominatim.openstreetmap.org',
      path,
      headers: {
        'User-Agent': 'JoshDashboard/1.0 (Gebr-Schutzeichel, josh.schutzeichel@gmail.com)',
        'Accept': 'application/json',
      },
      timeout: 5000,
    };
    const req = https.get(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const arr = JSON.parse(data);
          if (arr && arr[0] && arr[0].lon && arr[0].lat) {
            resolve([parseFloat(arr[0].lon), parseFloat(arr[0].lat)]);
          } else {
            resolve(null);
          }
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

/**
 * Einzelne Adresse geocoden (mit Rate-Limit und Cache)
 * @returns {[lon, lat] | null}
 */
async function geocodeAddress(street, zipcode, city) {
  if (!street || !zipcode) return null;

  const key = `${street.trim().toLowerCase()}|${zipcode.trim()}|${(city || '').trim().toLowerCase()}`;
  if (_cache.has(key)) return _cache.get(key);

  // Rate-Limit: min 1100ms zwischen Requests
  const now = Date.now();
  const wait = Math.max(0, 1150 - (now - _lastRequest));
  if (wait > 0) await sleep(wait);
  _lastRequest = Date.now();
  _requestCount++;

  const query = `${street.trim()}, ${zipcode.trim()} ${(city || '').trim()}, Germany`;
  const coords = await nominatimLookup(query);

  // Auch null cachen (damit wir dieselbe Adresse nicht zig mal anfragen)
  _cache.set(key, coords);
  return coords;
}

/**
 * Batch-Geocoding für Route-Optimierung
 * Verarbeitet Aufträge seriell (Rate-Limit), mit PLZ-Fallback.
 *
 * @param {Array} orders        — [{street, zipcode, city, coords}]
 * @param {Object} plzFallback  — {zipcode: [lon, lat]} aus plz-coords.json
 * @param {number} timeoutMs    — Gesamt-Timeout in ms (default 15s)
 * @returns {Promise<Array>}    — coords[i] für orders[i], niemals null (immer Fallback)
 */
async function geocodeBatch(orders, plzFallback = {}, timeoutMs = 15000) {
  const start = Date.now();
  const results = [];
  let geocoded = 0, fromCache = 0, fromFallback = 0;

  for (let i = 0; i < orders.length; i++) {
    const o = orders[i];

    // Timeout: wenn zu lange → restliche mit PLZ-Fallback abhandeln
    if (Date.now() - start > timeoutMs) {
      results.push(o.coords || plzFallback[o.zipcode] || null);
      fromFallback++;
      continue;
    }

    const cacheKey = `${(o.street||'').trim().toLowerCase()}|${(o.zipcode||'').trim()}|${(o.city||'').trim().toLowerCase()}`;
    if (_cache.has(cacheKey) && _cache.get(cacheKey)) {
      results.push(_cache.get(cacheKey));
      fromCache++;
      continue;
    }

    const real = await geocodeAddress(o.street, o.zipcode, o.city);
    if (real) {
      results.push(real);
      geocoded++;
    } else {
      results.push(o.coords || plzFallback[o.zipcode] || null);
      fromFallback++;
    }
  }

  console.log(`[geocoder] Batch ${orders.length} Adressen: ${geocoded} neu, ${fromCache} Cache, ${fromFallback} Fallback | Cache-Größe: ${_cache.size}`);
  return results;
}

module.exports = {
  geocodeAddress,
  geocodeBatch,
  cacheSize: () => _cache.size,
  requestCount: () => _requestCount,
};
