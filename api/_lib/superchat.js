const https = require('https');

function request(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.superchat.de',
      path,
      method,
      headers: {
        'x-api-key': process.env.SUPERCHAT_API_KEY || '1daf89c1-8ba6-4d91-9fdc-ba46ce1ba7ce',
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

async function getOpenConversations() {
  const { status, data } = await request('GET', '/v1/conversations?status=open&limit=50');
  if (status === 200 && data.items) return mapConversations(data.items);

  // Alternativer Endpoint
  const r2 = await request('GET', '/v1/chats?status=open&limit=50');
  if (r2.status === 200 && r2.data.items) return mapConversations(r2.data.items);

  return [];
}

function mapConversations(items) {
  return items.map(c => ({
    id: c.id,
    contactName: c.contact?.name || c.contactName || 'Unbekannt',
    phone: c.contact?.phone || c.phone || '',
    lastMessage: c.lastMessage?.text || c.preview || '',
    lastMessageAt: c.lastMessage?.createdAt || c.updatedAt || null,
    unreadCount: c.unreadCount || 0,
    status: c.status || 'open',
  }));
}

module.exports = { getOpenConversations };
