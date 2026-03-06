const { invalidateCache } = require('../_lib/superchat');
const { storeMessage } = require('../_lib/messageStore');

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

  // Nachrichten-Events verarbeiten
  if (eventType === 'message_inbound' || eventType === 'message_outbound') {
    const msg = event.message;
    if (msg?.conversation_id) {
      const body = msg.content?.body || '';
      const at = msg.created_at || new Date().toISOString();
      const direction = msg.direction || (eventType === 'message_inbound' ? 'inbound' : 'outbound');
      const from = eventType === 'message_inbound' ? msg.from : null;

      storeMessage(msg.conversation_id, {
        body,
        at,
        direction,
        contactId: from?.id || null,
        identifier: from?.identifier || null,
      });
    }
  }

  // Cache nach relevanten Events invalidieren → nächster /api/state Call holt frische Daten
  const relevantEvents = [
    'message_inbound',
    'message_outbound',
    'conversation_opened',
    'conversation_done',
    'conversation_snoozed',
  ];

  if (relevantEvents.includes(eventType)) {
    invalidateCache();
  }

  console.log('[Webhook]', eventType, event?.message?.conversation_id || event?.conversation?.id || '');
  res.status(200).json({ ok: true, event: eventType });
};
