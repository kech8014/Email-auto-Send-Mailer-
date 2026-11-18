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
    const session = http.sessionFrom(req);
    if (!isCron(req) && !session) {
      return http.json(res, 401, { error: 'Unauthorised' });
    }
    try {
      // The scheduled sweep covers every workspace. A signed-in person's heartbeat
      // only revives their own campaigns.
      const result = await worker.sweep(isCron(req) ? undefined : (session.ws || 'default'));
      return http.json(res, 200, Object.assign({ ok: true, mode: 'sweep' }, result));
    } catch (err) {
      console.error('[tick] sweep failed:', err);
      return http.json(res, 500, { error: 'Sweep failed' });
    }
  }

  if (!id) return http.json(res, 400, { error: 'Campaign id required' });

  const token = req.headers['x-worker-token'];
  const trusted = (token && worker.verifyWorkerToken(id, token)) || isCron(req);
  if (!trusted) {
    // A signed-in person may only tick a campaign that is theirs.
    const session = http.sessionFrom(req);
    if (!session) return http.json(res, 401, { error: 'Unauthorised' });
    const meta = await require('./_engine').getMeta(id);
    if (!meta || require('./_engine').wsOf(meta) !== (session.ws || 'default')) {
      return http.json(res, 404, { error: 'Campaign not found' });
    }
  }

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
