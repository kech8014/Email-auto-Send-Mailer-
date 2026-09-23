'use strict';

const store = require('./_store');
const engine = require('./_engine');
const worker = require('./_worker');

/**
 * Unauthenticated liveness probe. It reports whether the pieces the app depends
 * on are wired up, without leaking configuration detail.
 */
module.exports = async (req, res) => {
  const checks = {
    store: { driver: store.driver, durable: store.durable },
    baseUrl: Boolean(worker.baseUrl()),
    accessCodeConfigured: Boolean(process.env.ACCESS_CODE),
    secretKeyConfigured: Boolean(process.env.SECRET_KEY),
    mailboxConnected: false,
    activeCampaigns: 0
  };

  try {
    checks.mailboxConnected = Boolean(await engine.getConnection());
    const ids = await store.listCampaignIds();
    let active = 0;
    for (const id of ids.slice(0, 50)) {
      const meta = await engine.getMeta(id);
      if (meta && meta.status === 'running') active += 1;
    }
    checks.activeCampaigns = active;
  } catch (err) {
    checks.storeError = 'unreachable';
  }

  const warnings = [];
  if (!checks.store.durable) warnings.push('No persistent store configured - campaign state will not survive a cold start. Set KV_REST_API_URL/TOKEN or BLOB_READ_WRITE_TOKEN.');
  if (!checks.secretKeyConfigured) warnings.push('SECRET_KEY is not set - secrets fall back to the access code.');
  if (!checks.baseUrl) warnings.push('No public base URL - the worker cannot chain itself.');

  const healthy = checks.store.durable !== false || process.env.NODE_ENV !== 'production';

  res.statusCode = healthy ? 200 : 503;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify({
    status: healthy ? 'ok' : 'degraded',
    version: '1.0.0',
    time: new Date().toISOString(),
    checks,
    warnings
  }, null, 2));
};
