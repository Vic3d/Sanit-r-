const https = require('https');

const API_KEY = process.env.SUPERCHAT_API_KEY || '01a180cb-9f52-4a04-985a-93d14bfb4a34';

function request(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.superchat.com',
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

async function getLastMessage(conversationId) {
  const { status, data } = await request('GET', `/v1.0/conversations/${conversationId}/messages?limit=1`);
  if (status === 200 && data.results?.length) return data.results[0];
  return null;
}

// Cache invalidation flag - wird von Webhook gesetzt
let _cacheInvalid = false;
function invalidateCache() { _cacheInvalid = true; }
function checkAndResetInvalid() { const v = _cacheInvalid; _cacheInvalid = false; return v; }

async function getOpenConversations() {
  // Nur offene Conversations abrufen
  const { status, data } = await request('GET', '/v1.0/conversations?status=open&limit=20');
  if (status !== 200 || !data.results) return [];

  const conversations = data.results.slice(0, 15);

  // Kontakt- und Nachrichtendaten parallel laden
  const contactIds = [...new Set(conversations.map(c => c.contacts?.[0]?.id).filter(Boolean))];
  const contactMap = {};
  const messageMap = {};

  await Promise.all([
    // Kontakte laden
    ...contactIds.map(async (id) => {
      const c = await getContact(id);
      if (c) contactMap[id] = c;
    }),
    // Letzte Nachricht pro Conversation
    ...conversations.map(async (c) => {
      const msg = await getLastMessage(c.id);
      if (msg) messageMap[c.id] = msg;
    }),
  ]);

  return conversations.map(c => {
    const contactId = c.contacts?.[0]?.id;
    const contact = contactId ? contactMap[contactId] : null;

    const firstName = contact?.first_name || '';
    const lastName = contact?.last_name || '';
    const name = [firstName, lastName].filter(Boolean).join(' ') || 'Unbekannt';
    const phone = contact?.handles?.find(h => h.type === 'phone')?.value || '';

    const lastMsg = messageMap[c.id];
    const lastMessageBody = lastMsg?.content?.body || '';
    const lastMessageAt = lastMsg?.created_at || c.time_window?.open_until || null;
    const lastDirection = lastMsg?.direction || null; // 'inbound' | 'outbound'

    return {
      id: c.id,
      contactName: name,
      phone,
      lastMessage: lastMessageBody,
      lastMessageAt,
      lastDirection,
      unreadCount: 0,
      status: c.status || 'open',
      assignedTo: c.assigned_users?.[0]?.email || null,
    };
  });
}

module.exports = { getOpenConversations, invalidateCache, checkAndResetInvalid };
