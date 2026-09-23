'use strict';

/**
 * Local development server.
 *
 * Serves public/ and dispatches /api/* to the same handler modules Vercel runs,
 * so what is exercised here is the production code path rather than a stand-in.
 *
 *   node scripts/dev-server.js [port]
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.argv[2]) || 3400;

process.env.ACCESS_CODE = process.env.ACCESS_CODE || 'kech';
process.env.SECRET_KEY = process.env.SECRET_KEY || 'local-dev-key';
process.env.PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'http://127.0.0.1:' + PORT;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8'
};

function loadHandler(name) {
  const file = path.join(ROOT, 'api', name + '.js');
  if (!fs.existsSync(file)) return null;
  // Reload on every request so edits land without a restart.
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(path.join(ROOT, 'api'))) delete require.cache[key];
  }
  return require(file);
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url);
  const pathname = decodeURIComponent(parsed.pathname);

  if (pathname.startsWith('/api/')) {
    const name = pathname.slice(5).split('/')[0];
    const handler = loadHandler(name);
    if (!handler) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'No such endpoint: ' + name }));
    }
    // Vercel gives handlers a parsed query and a status/json helper.
    req.query = Object.fromEntries(new URLSearchParams(parsed.query || ''));
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (payload) => {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(payload));
      return res;
    };
    try {
      await handler(req, res);
    } catch (err) {
      console.error('[dev] handler error:', err);
      if (!res.writableEnded) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err.message) }));
      }
    }
    return;
  }

  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('Kech dev server  http://127.0.0.1:' + PORT);
  console.log('Access code: ' + process.env.ACCESS_CODE);
  console.log('Store driver: ' + require('../api/_store').driver + ' (in-memory unless KV/Blob env vars are set)');
});
