// Einfacher In-Memory Store für Webhook-Events
// Vercel hält Lambda-Instanzen warm → überlebt viele Requests
// Wird bei Cold Start geleert (akzeptabel — zeigt dann nur Namen/Timestamps)

const store = new Map(); // conversationId → { body, at, direction, contactName, phone }
const MAX_ENTRIES = 50;

/**
 * Speichert eine neue Nachricht aus dem Webhook
 */
function storeMessage(conversationId, { body, at, direction, contactId, identifier }) {
  store.set(conversationId, { body, at, direction, contactId, identifier, storedAt: Date.now() });
  // Alte Einträge aufräumen wenn zu viele
  if (store.size > MAX_ENTRIES) {
    const oldest = [...store.entries()]
      .sort((a, b) => a[1].storedAt - b[1].storedAt)[0];
    if (oldest) store.delete(oldest[0]);
  }
}

/**
 * Holt gespeicherte Nachricht für eine Conversation
 */
function getMessage(conversationId) {
  return store.get(conversationId) || null;
}

/**
 * Alle gespeicherten Nachrichten
 */
function getAll() {
  return Object.fromEntries(store);
}

module.exports = { storeMessage, getMessage, getAll };
