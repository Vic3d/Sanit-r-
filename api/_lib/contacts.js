/**
 * contacts.js — Alle Superchat-Kontakte laden (paginiert, gecached)
 * Gibt Array aller Kontakte zurück mit handles + custom_attributes
 */

const https = require('https');

const API_KEY = process.env.SUPERCHAT_API_KEY || '01a180cb-9f52-4a04-985a-93d14bfb4a34';
const BASE = 'api.superchat.com';
const CACHE_TTL = 10 * 60 * 1000; // 10 Minuten

let _cache = { contacts: null, at: 0 };

function request(method, path) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: BASE,
      path,
      method,
      headers: {
        'X-API-KEY': API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data: {} }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function getAllContacts(force = false) {
  const now = Date.now();
  if (!force && _cache.contacts && (now - _cache.at) < CACHE_TTL) {
    return _cache.contacts;
  }

  const PAGE_SIZE = 100;
  const allContacts = [];
  let cursor = null;
  let pages = 0;

  while (pages < 50) { // Safety: max 5000 Kontakte
    pages++;
    let url = `/v1.0/contacts?limit=${PAGE_SIZE}`;
    if (cursor) url += `&after=${cursor}`;

    const { status, data } = await request('GET', url);
    if (status !== 200 || !data.results) break;

    allContacts.push(...data.results);

    const nextCursor = data.pagination?.next_cursor;
    if (!nextCursor || data.results.length < PAGE_SIZE) break;
    cursor = nextCursor;
  }

  _cache = { contacts: allContacts, at: Date.now() };
  console.log(`[contacts] ${allContacts.length} Kontakte geladen (${pages} Seiten)`);
  return allContacts;
}

module.exports = { getAllContacts };
