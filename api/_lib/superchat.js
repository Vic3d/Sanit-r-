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

async function getOpenConversations() {
  const { status, data } = await request('GET', '/v1.0/conversations?status=open&limit=20');
  if (status !== 200 || !data.results) return [];

  // Kontaktdaten parallel laden (max 20 Conversations)
  const conversations = data.results.slice(0, 20);
  const contactIds = conversations
    .map(c => c.contacts?.[0]?.id)
    .filter(Boolean);

  // Unique contact IDs
  const uniqueIds = [...new Set(contactIds)];
  const contactMap = {};

  await Promise.all(
    uniqueIds.map(async (id) => {
      const contact = await getContact(id);
      if (contact) contactMap[id] = contact;
    })
  );

  return conversations.map(c => {
    const contactId = c.contacts?.[0]?.id;
    const contact = contactId ? contactMap[contactId] : null;

    const firstName = contact?.first_name || '';
    const lastName = contact?.last_name || '';
    const name = [firstName, lastName].filter(Boolean).join(' ') || 'Unbekannt';

    const phone = contact?.handles?.find(h => h.type === 'phone')?.value || '';

    return {
      id: c.id,
      contactName: name,
      phone,
      lastMessage: '',
      lastMessageAt: c.time_window?.open_until || null,
      unreadCount: 0,
      status: c.status || 'open',
      assignedTo: c.assigned_users?.[0]?.email || null,
    };
  });
}

module.exports = { getOpenConversations };
