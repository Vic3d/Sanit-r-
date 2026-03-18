/**
 * Lokaler Dev-Server für josh-dashboard
 * Simuliert Vercel Serverless Functions
 */

// Env vars aus .env.local laden (ohne dotenv-dependency)
try {
  const fs2 = require('fs');
  const envFile = fs2.readFileSync('.env.local', 'utf8');
  envFile.split('\n').forEach(line => {
    const [k, ...v] = line.split('=');
    if (k && v.length) process.env[k.trim()] = v.join('=').trim();
  });
} catch {}

const http = require('http');
const fs = require('fs');
const path = require('path');

const stateHandler = require('./api/state');
const acceptHandler = require('./api/accept');
const routesHandler = require('./api/routes');

const PORT = process.env.PORT || 3400;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  console.log(`[${new Date().toLocaleTimeString('de-DE')}] ${req.method} ${url.pathname}`);

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Express-like Helpers
  res.json = (data) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(data));
  };
  res.status = (code) => { res.statusCode = code; return res; };
  req.query = Object.fromEntries(new URL(req.url, `http://localhost`).searchParams);

  // API Routes
  if (url.pathname === '/api/state') return stateHandler(req, res);
  if (url.pathname === '/api/accept' && req.method === 'POST') return acceptHandler(req, res);
  if (url.pathname === '/api/routes') return routesHandler(req, res);

  // Static Files
  let filePath = path.join(__dirname, 'public', url.pathname === '/' ? 'index.html' : url.pathname);
  if (!fs.existsSync(filePath)) filePath = path.join(__dirname, 'public', 'index.html');

  const ext = path.extname(filePath);
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
  res.setHeader('Content-Type', mime[ext] || 'text/plain');
  fs.createReadStream(filePath).pipe(res);
});

server.listen(PORT, () => {
  console.log(`✅ Josh Dashboard läuft lokal: http://localhost:${PORT}`);
  console.log(`   Drücke Ctrl+C zum Beenden`);
});
