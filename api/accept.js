'use strict';
/**
 * api/accept.js — B&O Auftrag annehmen
 * GET /api/accept?id=269756909
 * Ruft bohwk.de/api/OrderState mit orderState=2 (Angenommen) auf.
 */

const https = require('https');
const { getSession } = require('./_lib/bohwk');

function cookieString(cookies) {
  return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
}

function httpsGet(path, cookies) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'bohwk.de',
      path,
      method: 'GET',
      headers: {
        'Cookie': cookieString(cookies),
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      }
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf-8') }));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('Timeout')));
    req.end();
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  const { id } = req.query;
  if (!id) return res.status(400).json({ ok: false, error: 'id fehlt' });

  try {
    const session = await getSession();

    const path = `/api/OrderState?orderDataSourceId=2&orderDataTypeId=1002&orderDateOfCompletion=&orderIdentificationId=2&orderMandatorId=1&orderSourceId=${encodeURIComponent(id)}&orderState=2&orderSubState=0`;

    const r = await httpsGet(path, session.cookies);

    let data;
    try { data = JSON.parse(r.body); } catch { data = { raw: r.body }; }

    if (r.status !== 200) {
      return res.status(502).json({ ok: false, error: `B&O Status ${r.status}`, data });
    }
    if (data && data.ErrorCode && data.ErrorCode !== 0) {
      return res.status(502).json({ ok: false, error: data.ErrorMessage || `ErrorCode ${data.ErrorCode}`, data });
    }

    return res.json({ ok: true, orderId: id, data });

  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
};
