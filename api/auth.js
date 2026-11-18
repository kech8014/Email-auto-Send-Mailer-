'use strict';

const http = require('./_http');
const secrets = require('./_crypto');
const store = require('./_store');
const users = require('./_users');

/**
 * Access-code sign in. The owner's code is compared in constant time against the
 * ACCESS_CODE environment variable; other people's codes are recognised by a
 * keyed digest. Codes are never echoed back. Each person signs in to their own
 * workspace, and any number of people can be signed in at once.
 *
 * Failed attempts are throttled per source address so the code cannot be
 * guessed by brute force.
 */

const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 8;

function clientKey(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return 'throttle/' + (fwd || req.socket.remoteAddress || 'unknown').replace(/[^\w.:-]/g, '');
}

module.exports = http.protect(async (req, res) => {
  const body = await http.readJson(req, 4096);
  const action = body.action || 'login';

  if (action === 'logout') {
    http.clearSessionCookie(res);
    return http.json(res, 200, { ok: true });
  }

  if (action === 'session') {
    let session = http.sessionFrom(req);
    // A person who has been removed is signed out on their next request.
    if (session && !(await users.isActive(session.ws))) session = null;
    return http.json(res, 200, {
      authenticated: Boolean(session),
      expiresAt: session ? session.exp : null,
      user: session ? { name: session.name, admin: session.admin === true } : null
    });
  }

  if (action !== 'login') return http.json(res, 400, { error: 'Unknown action' });

  const key = clientKey(req);
  const record = (await store.get(key)) || { attempts: [], lockedUntil: 0 };
  const now = Date.now();

  if (record.lockedUntil > now) {
    return http.json(res, 429, {
      error: 'Too many failed attempts. Try again in ' + Math.ceil((record.lockedUntil - now) / 60000) + ' minutes.'
    });
  }

  record.attempts = (record.attempts || []).filter((t) => now - t < ATTEMPT_WINDOW_MS);

  const identity = await users.authenticate(body.code);
  if (!identity) {
    record.attempts.push(now);
    if (record.attempts.length >= MAX_ATTEMPTS) {
      record.lockedUntil = now + ATTEMPT_WINDOW_MS;
      record.attempts = [];
    }
    await store.set(key, record);
    // Uniform delay so a wrong code cannot be distinguished by timing.
    await new Promise((r) => setTimeout(r, 350));
    return http.json(res, 401, {
      error: 'Invalid access code',
      remaining: Math.max(0, MAX_ATTEMPTS - record.attempts.length)
    });
  }

  await store.del(key);
  const token = secrets.issueSession(identity);
  http.setSessionCookie(res, token);
  return http.json(res, 200, {
    ok: true,
    expiresAt: Date.now() + secrets.SESSION_TTL_MS,
    user: { name: identity.name, admin: identity.admin === true }
  });
}, { public: true, methods: ['POST'] });
