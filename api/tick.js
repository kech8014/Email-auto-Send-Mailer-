'use strict';

const http = require('./_http');
const worker = require('./_worker');

/**
 * The worker entry point.
 *
 * Three callers reach it, each authorised differently:
 *   - the worker chaining to itself, with an HMAC token scoped to one campaign
 *   - the platform cron sweep, with Vercel's own cron header or the cron secret
 *   - an authenticated dashboard session, as a heartbeat that revives a chain
 *     that died mid-flight
 *
 * It never trusts an unauthenticated caller, because it sends real email.
 */

function isCron(req) {
  if (req.headers['x-vercel-cron']) return true;
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = String(req.headers.authorization || '');
  return auth === 'Bearer ' + secret;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST' && req.method !== 'GET') {
    return http.json(res, 405, { error: 'Method not allowed' });
  }

  let body = {};
  if (req.method === 'POST') {
    try { body = await http.readJson(req, 8192); } catch (_) { body = {}; }
  }

  const url = new URL(req.url, 'http://localhost');
  const id = body.id || url.searchParams.get('id');
  const wantsSweep = body.sweep || url.searchParams.get('sweep') === '1' || (!id && isCron(req));

  // Sweep: restart any chain that stalled.
  if (wantsSweep) {
    if (!isCron(req) && !http.sessionFrom(req)) {
      return http.json(res, 401, { error: 'Unauthorised' });
    }
    try {
      const result = await worker.sweep();
      return http.json(res, 200, Object.assign({ ok: true, mode: 'sweep' }, result));
    } catch (err) {
      console.error('[tick] sweep failed:', err);
      return http.json(res, 500, { error: 'Sweep failed' });
    }
  }

  if (!id) return http.json(res, 400, { error: 'Campaign id required' });

  const token = req.headers['x-worker-token'];
  const authorised = (token && worker.verifyWorkerToken(id, token)) || isCron(req) || Boolean(http.sessionFrom(req));
  if (!authorised) return http.json(res, 401, { error: 'Unauthorised' });

  try {
    const result = await worker.runTick(id);
    return http.json(res, result.ok === false ? 400 : 200, result);
  } catch (err) {
    console.error('[tick] campaign ' + id + ' failed:', err && err.stack ? err.stack : err);
    // Try to keep the chain alive even after an unexpected failure.
    try { await worker.chain(id); } catch (_) {}
    return http.json(res, 500, { error: 'Worker error', message: String(err.message) });
  }
};
