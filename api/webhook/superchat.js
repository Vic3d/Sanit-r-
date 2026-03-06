const { invalidateCache } = require('../_lib/superchat');

// Superchat Webhook Receiver
// Superchat schickt Events hierher wenn:
//  - Neue Nachricht eingeht (message_inbound)
//  - Nachricht gesendet wurde (message_outbound)
//  - Conversation-Status ändert sich (conversation_opened/done/snoozed)
//  - Kontakt angelegt/geändert (contact_created/updated)

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const event = req.body;
  const eventType = event?.event;

  console.log('[Superchat Webhook]', eventType, JSON.stringify(event).substring(0, 200));

  // Cache nach relevanten Events invalidieren
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

  // Immer 200 zurückgeben damit Superchat zufrieden ist
  res.status(200).json({ ok: true, event: eventType });
};
