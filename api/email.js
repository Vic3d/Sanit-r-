'use strict';
// api/email.js — OWA Email Triage für Schutzeichel
// Holt Emails aus allen relevanten Postfächern, klassifiziert sie
// und liefert strukturiertes JSON für das Dashboard.

const https = require('https');
const qs    = require('querystring');

const AGENT = new https.Agent({ rejectUnauthorized: false });

const ACCOUNTS = [
  { name: 'INFO2',   label: 'info@gebr-schutzeichel.de',    user: 'phx-hosting\\info2',    pass: '*8166Belinea',  relevant: true  },
  { name: 'AUFTRAG', label: 'auftrag@gebr-schutzeichel.de', user: 'phx-hosting\\auftrag',  pass: '*8166*Belinea', relevant: true  },
  { name: 'RECHNUNG',label: 'rechnung@gebr-schutzeichel.de',user: 'phx-hosting\\rechnung', pass: '*8166*Belinea', relevant: false },
  { name: 'VICTOR',  label: 'victor@gebr-schutzeichel.de',  user: 'phx-hosting\\victor',   pass: '*8166Belinea',  relevant: false },
];

// ── Klassifikations-Regeln ────────────────────────────────────
const URGENT_KW    = ['notfall', 'dringend', 'sofort', 'leck', 'rohrbruch', 'wassereinbruch', 'gasgeruch', 'überschwemmung', 'havarie', 'nass'];
const ORDER_KW     = ['b&o', 'buo', 'buo_auftrag', 'tsp', 'kopplung', 'bohandwerkerkopplung', 'handwerkerkopplung', 'pertec', 'risadelli', 'technikserviceplus', 'reparaturauftrag', 'als anlage erhalten', 'zahlungsavis', 'hausverwaltung'];
const INQUIRY_KW   = ['anfrage', 'angebot', 'kostenvoranschlag', 'reparatur', 'installation', 'wartung', 'heizung', 'sanitär', 'therme', 'boiler', 'heizkörper', 'badezimmer', 'waschtisch', 'gastherme', 'warmwasser', 'termin vereinbar', 'haben sie zeit'];
const SPAM_SENDERS = ['myhammer', 'my-hammer', 'noreply@info.my-hammer', 'noreply-bohandwe', 'qm-akademie', 'viessmann.live', 'fachverband shk', 'dortmund@info.vi', 'instagram', 'xing.com', 'linkedin', 'kununu', 'stepstone', 'newsletter', 'noreply@info.', 'marketing@', 'no-reply@'];
const SPAM_WORDS   = ['newsletter', 'abmelden', 'gutschein', 'rabatt', 'aktion bis', 'jetzt bestellen', 'nur heute', 'angebot gültig', 'schadstoff'];

function classify(text, sender) {
  const t = text.toLowerCase();
  const s = (sender || '').toLowerCase();
  if (SPAM_SENDERS.some(kw => s.includes(kw)) || SPAM_WORDS.some(kw => t.includes(kw)))
    return 'SPAM';
  if (URGENT_KW.some(kw => t.includes(kw)))
    return 'DRINGEND';
  if (ORDER_KW.some(kw => t.includes(kw)))
    return 'AUFTRAG';
  if (INQUIRY_KW.some(kw => t.includes(kw)))
    return 'ANFRAGE';
  return 'SONSTIGE';
}

// ── HTTPS Helper ──────────────────────────────────────────────
function httpsReq(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request({ ...options, agent: AGENT }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('OWA timeout')));
    if (body) req.write(body);
    req.end();
  });
}

// ── OWA Login ─────────────────────────────────────────────────
async function owaLogin(user, pass) {
  const body = qs.stringify({
    destination: 'https://mail.phx-hosting.de/owa/',
    flags: '4', forcedownlevel: '0', isUtf8: '1',
    username: user, password: pass,
  });
  const res = await httpsReq({
    hostname: 'mail.phx-hosting.de',
    path: '/owa/auth.owa',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
      'User-Agent': 'curl/7.88.1',
    },
  }, body);

  if (res.status !== 302 && res.status !== 301) return null;
  const cookies = {};
  const raw = res.headers['set-cookie'] || [];
  for (const c of (Array.isArray(raw) ? raw : [raw])) {
    const m = c.match(/^(\w+)=([^;]+)/);
    if (m) cookies[m[1]] = m[2];
  }
  return Object.keys(cookies).length > 0 ? cookies : null;
}

// ── Inbox Fetch ───────────────────────────────────────────────
async function getInbox(cookies) {
  const cookieStr = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  const res = await httpsReq({
    hostname: 'mail.phx-hosting.de',
    path: '/owa/',
    method: 'GET',
    headers: { 'Cookie': cookieStr, 'User-Agent': 'curl/7.88.1' },
  });
  return res.body;
}

// ── HTML Parser ───────────────────────────────────────────────
function parseInbox(html, accountName) {
  const emails = [];
  // Message IDs
  const idPattern = /name="chkmsg" value="(RgAAAA[A-Za-z0-9+/=]+AAAJ)"/g;
  const allIds = [];
  let m;
  while ((m = idPattern.exec(html)) !== null) allIds.push(m[1]);

  // Rows mit Datum
  const rowRx = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const dateRx = /(\d{2}\.\d{2}\.\d{4})\s+(\d{2}:\d{2})/;
  const sizeRx = /(\d+(?:\.\d+)?\s*(?:KB|MB))/i;

  let idx = 0;
  let rowMatch;
  while ((rowMatch = rowRx.exec(html)) !== null) {
    const raw = rowMatch[1];

    // Zellen separat extrahieren (</td> als Trenner) → bessere Sender/Subject-Trennung
    const cells = raw
      .replace(/<\/td>/gi, '\x00')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&#(\d+);/g, (_, n) => n < 65536 ? String.fromCharCode(n) : '?')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .split('\x00')
      .map(c => c.replace(/\s+/g, ' ').trim())
      .filter(Boolean);

    const clean = cells.join(' ');
    const dm = dateRx.exec(clean);
    if (!dm || clean.length < 20) continue;

    const date  = `${dm[1]} ${dm[2]}`;
    const sm    = sizeRx.exec(clean);
    const msgId = allIds[idx] || '';
    idx++;

    const isUnread = /<b>/i.test(raw);
    const owaLink  = msgId
      ? `https://mail.phx-hosting.de/owa/?ae=Item&t=IPM.Note&id=${encodeURIComponent(msgId)}&a=Open`
      : null;

    // Sender = erste Nicht-Datum-Zelle, Subject = zweite
    const contentCells = cells.filter(c => !dateRx.test(c) && !sizeRx.test(c) && c.length > 1);
    const sender  = contentCells[0] || '—';
    const subject = contentCells[1] || contentCells[0] || '—';

    const category = classify(clean, sender);

    // Parse date to sortable ISO
    const [dd, MM, yyyy] = date.split(/[\s.]/);
    const hhmm = date.slice(-5);
    const isoDate = `${yyyy}-${MM}-${dd}T${hhmm}`;

    emails.push({ id: msgId, account: accountName, sender, subject, date, isoDate, isUnread, owaLink, category, raw: clean.slice(0, 200) });
  }

  return emails;
}

// ── In-Memory Cache (30 Min) ──────────────────────────────────
let CACHE = null;
let CACHE_AT = 0;
const CACHE_TTL = 30 * 60 * 1000;

// ── Main Handler ──────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  // Force-refresh via ?refresh=1
  const force = req.url && req.url.includes('refresh=1');

  if (!force && CACHE && Date.now() - CACHE_AT < CACHE_TTL) {
    return res.status(200).json({ ...CACHE, cached: true, cacheAge: Math.round((Date.now() - CACHE_AT) / 1000) });
  }

  const allEmails = [];
  const errors = [];

  // Alle relevanten Accounts parallel
  await Promise.allSettled(
    ACCOUNTS.filter(a => a.relevant).map(async (acc) => {
      try {
        const cookies = await owaLogin(acc.user, acc.pass);
        if (!cookies) { errors.push(`${acc.name}: Login fehlgeschlagen`); return; }
        const html = await getInbox(cookies);
        if (!html || html.length < 200) { errors.push(`${acc.name}: Inbox leer`); return; }
        const parsed = parseInbox(html, acc.name);
        allEmails.push(...parsed);
      } catch (e) {
        errors.push(`${acc.name}: ${e.message}`);
      }
    })
  );

  // Sortieren: ungelesen zuerst, dann nach Datum
  allEmails.sort((a, b) => {
    if (a.isUnread !== b.isUnread) return a.isUnread ? -1 : 1;
    return b.isoDate.localeCompare(a.isoDate);
  });

  // Kategorien
  const byCategory = {
    DRINGEND: allEmails.filter(e => e.category === 'DRINGEND'),
    AUFTRAG:  allEmails.filter(e => e.category === 'AUFTRAG'),
    ANFRAGE:  allEmails.filter(e => e.category === 'ANFRAGE'),
    SONSTIGE: allEmails.filter(e => e.category === 'SONSTIGE'),
    SPAM:     allEmails.filter(e => e.category === 'SPAM'),
  };

  const unreadTotal = allEmails.filter(e => e.isUnread).length;

  const result = {
    ok: true,
    total: allEmails.length,
    unread: unreadTotal,
    byCategory,
    errors,
    fetchedAt: new Date().toISOString(),
    cached: false,
  };

  CACHE = result;
  CACHE_AT = Date.now();

  return res.status(200).json(result);
};
