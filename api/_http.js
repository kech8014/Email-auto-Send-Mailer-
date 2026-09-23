'use strict';

const secrets = require('./_crypto');

const COOKIE_NAME = 'kech_session';

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

/**
 * The session lives in an HttpOnly cookie so no credential or token is ever
 * reachable from page JavaScript or browser storage.
 */
function setSessionCookie(res, token) {
  const attrs = [
    COOKIE_NAME + '=' + encodeURIComponent(token),
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=' + Math.floor(secrets.SESSION_TTL_MS / 1000)
  ];
  if (process.env.VERCEL) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

function clearSessionCookie(res) {
  const attrs = [COOKIE_NAME + '=', 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (process.env.VERCEL) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

function sessionFrom(req) {
  return secrets.verifySession(parseCookies(req)[COOKIE_NAME]);
}

async function readJson(req, limitBytes) {
  if (req.body && typeof req.body === 'object') return req.body;
  const limit = limitBytes || 6 * 1024 * 1024;
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('Payload too large'), { statusCode: 413 });
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

/** Wrap a handler with auth, method checks and structured error handling. */
function protect(handler, options) {
  const opts = options || {};
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    const methods = opts.methods || ['POST'];
    if (!methods.includes(req.method)) {
      return json(res, 405, { error: 'Method not allowed' });
    }

    let session = null;
    if (!opts.public) {
      session = sessionFrom(req);
      if (!session) return json(res, 401, { error: 'Session expired or missing', code: 'unauthenticated' });
    }

    try {
      await handler(req, res, session);
    } catch (err) {
      const status = err && err.statusCode ? err.statusCode : 500;
      // Log server-side with detail; return something safe to the client.
      console.error('[api] ' + req.url + ' failed:', err && err.stack ? err.stack : err);
      if (!res.writableEnded) {
        json(res, status, { error: status === 500 ? 'Internal server error' : String(err.message) });
      }
    }
  };
}

module.exports = { protect, readJson, json, setSessionCookie, clearSessionCookie, sessionFrom, parseCookies, COOKIE_NAME };
