const https = require('https');
const { getMessage } = require('./messageStore');

// Vercel KV (persistent, cross-instance) — optional
let kv = null;
function getKV() {
  if (kv !== null) return kv;
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    kv = false;
    return kv;
  }
  try {
    kv = require('@vercel/kv').kv;
  } catch {
    kv = false;
  }
  return kv;
}

const API_KEY = process.env.SUPERCHAT_API_KEY || '01a180cb-9f52-4a04-985a-93d14bfb4a34';
const BASE = 'api.superchat.com';

function request(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: BASE,
      path,
      method,
      headers: {
        'X-API-KEY': API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
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
    if (payload) req.write(payload);
    req.end();
  });
}

async function getContact(contactId) {
  const { status, data } = await request('GET', `/v1.0/contacts/${contactId}`);
  if (status === 200) return data;
  return null;
}

// ── Cursor-Cache ──────────────────────────────────────────────────
// API sortiert älteste zuerst. Wir merken uns den Cursor vom vorletzten
// Batch, sodass wir beim nächsten Load nur die letzten ~100 Conversations
// neu laden müssen.
let _cursorCache = null; // cursor für die letzte bekannte "sichere" Position
let _knownConvs = new Map(); // conversationId → conversation-Objekt

async function fetchAllOpenTimeWindow() {
  const PAGE_SIZE = 100;
  let url = `/v1.0/conversations?limit=${PAGE_SIZE}`;

  // Wenn wir einen Cursor-Cache haben: von dort weitermachen
  // (holt nur die letzten Seiten, wo neue Conversations sein könnten)
  if (_cursorCache) {
    url = `/v1.0/conversations?limit=${PAGE_SIZE}&after=${_cursorCache}`;
  }

  let prevCursorForCache = _cursorCache;
  let pages = 0;

  while (url) {
    pages++;
    const { status, data } = await request('GET', url);
    if (status !== 200 || !data.results) break;

    const results = data.results;

    // Alle Conversations in _knownConvs einpflegen/updaten
    results.forEach(c => _knownConvs.set(c.id, c));

    const nextCursor = data.pagination?.next_cursor;

    if (nextCursor) {
      // Merke den Cursor der vorletzten Seite (sicherer Start für nächstes Mal)
      prevCursorForCache = nextCursor;
      url = `/v1.0/conversations?limit=${PAGE_SIZE}&after=${nextCursor}`;
    } else {
      // Letzte Seite erreicht — Cursor-Cache aktualisieren
      // Setze auf 2 Seiten zurück damit wir overlap haben für neue Conversations
      _cursorCache = prevCursorForCache;
      url = null;
    }

    // Safety: max 10 Seiten (1000 Conversations) pro Durchlauf
    if (pages >= 10) break;
  }

  // Nur Conversations mit aktivem 24h-Fenster zurückgeben
  const now = new Date();
  return [..._knownConvs.values()].filter(c => {
    const until = c.time_window?.open_until;
    if (!until) return false;
    return new Date(until) > now && c.time_window?.state === 'open';
  });
}

// ── Cache-Invalidierung via Webhook ──────────────────────────────
let _cacheInvalid = false;
function invalidateCache() { _cacheInvalid = true; }
function checkAndResetInvalid() { const v = _cacheInvalid; _cacheInvalid = false; return v; }

// Neue Conversation aus Webhook direkt in _knownConvs eintragen
function updateConversation(conversationId, update) {
  if (_knownConvs.has(conversationId)) {
    const existing = _knownConvs.get(conversationId);
    _knownConvs.set(conversationId, { ...existing, ...update });
  }
}

// ── Hauptfunktion ─────────────────────────────────────────────────
async function getOpenConversations() {
  const openConvs = await fetchAllOpenTimeWindow();

  if (!openConvs.length) return [];

  // Sortieren: neuestes 24h-Fenster zuletzt (= älteste Conversation zuerst)
  // → nein, wir wollen neuestes ZUERST (kürzlich geschrieben)
  openConvs.sort((a, b) => {
    const ta = a.time_window?.open_until || '';
    const tb = b.time_window?.open_until || '';
    return tb.localeCompare(ta); // neueste zuerst
  });

  // Kontaktdaten parallel laden
  const contactIds = [...new Set(openConvs.map(c => c.contacts?.[0]?.id).filter(Boolean))];
  const contactMap = {};
  await Promise.all(
    contactIds.map(async (id) => {
      const c = await getContact(id);
      if (c) contactMap[id] = c;
    })
  );

  // KV-Batch-Abfrage für alle Konversationen (persistent, cross-instance)
  const store = getKV();
  let kvDirections = {};
  if (store) {
    try {
      const keys = openConvs.map(c => `conv:${c.id}`);
      const values = await store.mget(...keys);
      keys.forEach((key, i) => {
        if (values[i]) kvDirections[openConvs[i].id] = values[i];
      });
    } catch (e) {
      console.error('[Superchat] KV mget failed:', e.message);
    }
  }

  return openConvs.map(c => {
    const contactId = c.contacts?.[0]?.id;
    const contact = contactId ? contactMap[contactId] : null;

    const firstName = contact?.first_name || '';
    const lastName = contact?.last_name || '';
    const name = [firstName, lastName].filter(Boolean).join(' ') || contact?.handles?.[0]?.value || 'Unbekannt';
    const phone = contact?.handles?.find(h => h.type === 'phone')?.value || '';

    // Prio 1: Vercel KV (persistent)
    // Prio 2: In-Memory Store (selbe Instanz, Warmstart)
    // Prio 3: Zeitfenster-Heuristik (Fallback)
    const kvData = kvDirections[c.id] || null;
    const memData = getMessage(c.id);
    const stored = kvData || memData;

    const lastMessageBody = stored?.body || '';
    const lastMessageAt = stored?.at || null;

    // Wie viel Zeit noch im 24h-Fenster?
    const until = c.time_window?.open_until;
    const minutesLeft = until
      ? Math.max(0, Math.round((new Date(until) - Date.now()) / 60000))
      : null;

    // Richtung bestimmen
    let lastDirection = stored?.direction || null;
    if (!lastDirection && minutesLeft !== null) {
      // Heuristik: >23h verbleibend → Kunde hat in letzter Stunde geschrieben
      if (minutesLeft > 1380) lastDirection = 'inbound';
    }

    return {
      id: c.id,
      contactName: name,
      phone,
      lastMessage: lastMessageBody,
      lastMessageAt,
      lastDirection,
      minutesLeft,
      timeWindowUntil: until,
      status: c.status || 'open',
      assignedTo: c.assigned_users?.[0]?.email || null,
      _kvData: !!kvData, // Debug-Infos
    };
  });
}

module.exports = { getOpenConversations, invalidateCache, checkAndResetInvalid, updateConversation };
