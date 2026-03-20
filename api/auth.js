// /data/.openclaw/workspace/josh-dashboard/api/auth.js
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const PASSWORDS = {
    chef: process.env.CHEF_PASSWORD || 'Josh2026',
    backoffice: process.env.BACKOFFICE_PASSWORD || 'Victor2026',
  };

  // POST /api/auth — Login
  if (req.method === 'POST') {
    const { password } = req.body || {};
    let role = null;
    for (const [r, pw] of Object.entries(PASSWORDS)) {
      if (pw === password) role = r;
    }
    if (!role) return res.status(401).json({ error: 'Falsches Passwort' });
    const token = Buffer.from(`${role}:${Date.now()}`).toString('base64');
    return res.status(200).json({ token, role });
  }

  // GET /api/auth — Verify token (TRA-208: check 8h expiry)
  if (req.method === 'GET') {
    const auth = req.headers.authorization || '';
    const token = auth.replace('Bearer ', '');
    try {
      const decoded = Buffer.from(token, 'base64').toString();
      const [role, timestamp] = decoded.split(':');
      const age = Date.now() - parseInt(timestamp || '0');
      const MAX_AGE = 8 * 60 * 60 * 1000; // 8h
      if (['chef','backoffice'].includes(role) && age < MAX_AGE) {
        return res.status(200).json({ valid: true, role });
      }
    } catch {}
    return res.status(401).json({ valid: false });
  }

  res.status(405).end();
};
