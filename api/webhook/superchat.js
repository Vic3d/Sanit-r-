const { storeMessage } = require('../_lib/messageStore');

// Vercel KV (Redis) — nur wenn konfiguriert
let kv = null;
function getKV() {
  if (kv !== null) return kv;
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    kv = false; // nicht konfiguriert
    return kv;
  }
  try {
    kv = require('@vercel/kv').kv;
  } catch {
    kv = false;
  }
  return kv;
}

// Superchat Webhook Receiver
// Superchat schickt Events hierher bei:
//  message_inbound  → Kunde schreibt
//  message_outbound → Antwort wurde gesendet
//  conversation_opened / conversation_done / conversation_snoozed

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const event = req.body;
  const eventType = event?.event;

  // Conversation als erledigt markieren → aus KV entfernen
  if (eventType === 'conversation_done') {
    const convId = event.conversation?.id;
    if (convId) {
      const store = getKV();
      if (store) {
        try { await store.del(`conv:${convId}`); } catch {}
      }
    }
  }

  // Nachrichten-Events verarbeiten
  if (eventType === 'message_inbound' || eventType === 'message_outbound') {
    const msg = event.message;
    if (msg?.conversation_id) {
      const body = msg.content?.body || '';
      const at = msg.created_at || new Date().toISOString();
      const direction = msg.direction || (eventType === 'message_inbound' ? 'inbound' : 'outbound');
      const from = eventType === 'message_inbound' ? msg.from : null;

      const msgData = {
        body,
        at,
        direction,
        contactId: from?.id || null,
        identifier: from?.identifier || null,
      };

      // In-Memory Store (Fallback)
      storeMessage(msg.conversation_id, msgData);

      // Vercel KV (persistent, cross-instance) — TTL 48h
      const store = getKV();
      if (store) {
        try {
          await store.set(`conv:${msg.conversation_id}`, msgData, { ex: 48 * 3600 });
        } catch (e) {
          console.error('[Webhook] KV write failed:', e.message);
        }
      }
    }
  }

  console.log('[Webhook]', eventType, event?.message?.conversation_id || event?.conversation?.id || '');
  res.status(200).json({ ok: true, event: eventType });
};
