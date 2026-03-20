// Manuell als "gelesen" markieren — löscht KV-Eintrag für eine Conversation
// → Badge verschwindet, ohne dass Superchat geöffnet werden muss

let kv = null;
function getKV() {
  if (kv !== null) return kv;
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) { kv = false; return kv; }
  try { kv = require('@vercel/kv').kv; } catch { kv = false; }
  return kv;
}

const { storeMessage } = require('./_lib/messageStore');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

  const { convId } = req.body || {};
  if (!convId) return res.status(400).json({ error: 'convId required' });

  // In-Memory Store: als "outbound" markieren (= beantwortet/gelesen)
  storeMessage(convId, { direction: 'outbound', body: '', at: new Date().toISOString() });

  // KV: Eintrag löschen → kein Badge mehr
  const store = getKV();
  if (store) {
    try { await store.del(`conv:${convId}`); } catch (e) {
      console.error('[ACK] KV del failed:', e.message);
    }
  }

  res.json({ ok: true });
};
