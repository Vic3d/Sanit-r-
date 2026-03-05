/**
 * bohwk.de Session Manager – reines HTTP, kein Playwright
 * Login: GET → POST (Loginname!) → Follow Redirect → ASP.NET_SessionId
 */

const https = require('https');
const querystring = require('querystring');

// Module-level cache (überlebt innerhalb einer Lambda-Instanz)
let _session = null;

function httpsRequest(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf-8')
      }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function parseCookies(setCookieHeaders) {
  const cookies = {};
  if (!setCookieHeaders) return cookies;
  const headers = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
  for (const h of headers) {
    const [pair] = h.split(';');
    const [name, ...rest] = pair.split('=');
    cookies[name.trim()] = rest.join('=').trim();
  }
  return cookies;
}

function cookieString(cookies) {
  return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
}

async function login() {
  console.log('[bohwk] Starte Login...');
  const cookies = {};

  // Step 1: GET Login-Seite (ARRAffinity + CSRF-Token)
  const r1 = await httpsRequest({
    hostname: 'bohwk.de',
    path: '/Account/Login',
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    }
  });

  Object.assign(cookies, parseCookies(r1.headers['set-cookie']));
  const tokenMatch = r1.body.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/);
  if (!tokenMatch) throw new Error('CSRF Token nicht gefunden');
  const csrfToken = tokenMatch[1];

  // Step 2: POST Login (Loginname statt UserName!)
  const body = querystring.stringify({
    Loginname: process.env.BOHWK_USER || 'auftrag@gebr-schutzeichel.de',
    Password: process.env.BOHWK_PASS || '*8166*Belinea',
    __RequestVerificationToken: csrfToken
  });

  const r2 = await httpsRequest({
    hostname: 'bohwk.de',
    path: '/Account/Login?ReturnUrl=%2F',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
      'Cookie': cookieString(cookies),
      'Origin': 'https://bohwk.de',
      'Referer': 'https://bohwk.de/Account/Login',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    }
  }, body);

  Object.assign(cookies, parseCookies(r2.headers['set-cookie']));
  if (r2.status !== 302) throw new Error(`Login fehlgeschlagen (${r2.status})`);

  // Step 3: GET / (folge Redirect → ASP.NET_SessionId)
  const r3 = await httpsRequest({
    hostname: 'bohwk.de',
    path: r2.headers['location'] || '/',
    method: 'GET',
    headers: {
      'Cookie': cookieString(cookies),
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    }
  });

  Object.assign(cookies, parseCookies(r3.headers['set-cookie']));

  // Step 4: Identity-Token holen
  const r4 = await httpsRequest({
    hostname: 'bohwk.de',
    path: '/api/Identity',
    method: 'GET',
    headers: {
      'Cookie': cookieString(cookies),
      'Accept': 'application/json',
    }
  });

  const identity = JSON.parse(r4.body);
  if (!identity.Token) throw new Error('Identity-Token nicht erhalten: ' + JSON.stringify(identity));

  _session = { cookies, token: identity.Token, userId: identity.SystemuserId, loginAt: Date.now() };
  console.log('[bohwk] Login OK, UserID:', identity.SystemuserId);
  return _session;
}

async function getSession() {
  // Session cachen, alle 6h neu einloggen
  if (_session && (Date.now() - _session.loginAt) < 6 * 60 * 60 * 1000) {
    return _session;
  }
  return login();
}

async function apiGet(path) {
  const session = await getSession();
  const r = await httpsRequest({
    hostname: 'bohwk.de',
    path,
    method: 'GET',
    headers: {
      'Cookie': cookieString(session.cookies),
      'Accept': 'application/json',
    }
  });

  const data = JSON.parse(r.body);
  // Session abgelaufen? Neu einloggen
  if (data.ErrorCode === -1140001) {
    _session = null;
    const newSession = await login();
    const r2 = await httpsRequest({
      hostname: 'bohwk.de',
      path,
      method: 'GET',
      headers: {
        'Cookie': cookieString(newSession.cookies),
        'Accept': 'application/json',
      }
    });
    return JSON.parse(r2.body);
  }
  return data;
}

async function getOrders() {
  const data = await apiGet('/api/orders');
  return data.GetOrdersByTechnicianInTimespanResult?.DataList || [];
}

module.exports = { getOrders, getSession };
