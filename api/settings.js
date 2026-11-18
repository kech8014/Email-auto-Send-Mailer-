'use strict';

const http = require('./_http');
const engine = require('./_engine');
const users = require('./_users');

/** Workspace defaults: pacing policy, retry policy, templates, retention. */

function sanitisePacing(input) {
  if (!input) return {};
  const out = {};
  if (input.minDelayMs != null) out.minDelayMs = clamp(Number(input.minDelayMs), 1000, 3600000);
  if (input.maxDelayMs != null) out.maxDelayMs = clamp(Number(input.maxDelayMs), 1000, 3600000);
  if (input.randomize != null) out.randomize = Boolean(input.randomize);
  if (input.hourlyCap != null) out.hourlyCap = clamp(Number(input.hourlyCap), 1, 10000);
  if (input.dailyCap != null) out.dailyCap = clamp(Number(input.dailyCap), 1, 100000);
  if (out.minDelayMs && out.maxDelayMs && out.maxDelayMs < out.minDelayMs) {
    out.maxDelayMs = out.minDelayMs;
  }
  return out;
}

function sanitiseRetry(input) {
  if (!input) return {};
  const out = {};
  if (input.maxAttempts != null) out.maxAttempts = clamp(Number(input.maxAttempts), 1, 10);
  if (input.baseBackoffMs != null) out.baseBackoffMs = clamp(Number(input.baseBackoffMs), 1000, 900000);
  return out;
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

module.exports = http.protect(async (req, res, session) => {
  const body = await http.readJson(req, 128 * 1024);
  // Settings and the suppression list belong to whoever is signed in.
  const ws = (session && session.ws) || 'default';
  const isOwner = Boolean(session && session.admin === true && ws === 'default');

  // ---- People (owner only) -------------------------------------------------
  if (typeof body.action === 'string' && body.action.startsWith('users-')) {
    if (!isOwner) return http.json(res, 403, { error: 'Only the owner can manage people' });
    if (body.action === 'users-list') {
      return http.json(res, 200, { users: await users.listUsers() });
    }
    if (body.action === 'users-add') {
      return http.json(res, 200, await users.addUser(body.name));
    }
    if (body.action === 'users-reset') {
      return http.json(res, 200, await users.resetCode(String(body.id || '')));
    }
    if (body.action === 'users-remove') {
      return http.json(res, 200, await users.removeUser(String(body.id || ''), engine));
    }
    return http.json(res, 400, { error: 'Unknown action' });
  }

  if (body.action === 'get') {
    return http.json(res, 200, {
      settings: await engine.getSettings(ws),
      suppression: (await engine.getSuppression(ws)).length
    });
  }

  if (body.action === 'save') {
    const patch = {};
    if (body.pacing) patch.pacing = sanitisePacing(body.pacing);
    if (body.retry) patch.retry = sanitiseRetry(body.retry);
    for (const key of ['defaultSubject', 'defaultBody', 'timezone', 'unsubscribeMailto']) {
      if (body[key] !== undefined) patch[key] = body[key];
    }
    if (body.retentionDays !== undefined) patch.retentionDays = clamp(Number(body.retentionDays), 1, 3650);
    return http.json(res, 200, { settings: await engine.saveSettings(patch, ws) });
  }

  if (body.action === 'suppression-list') {
    return http.json(res, 200, { emails: await engine.getSuppression(ws) });
  }

  if (body.action === 'suppression-add') {
    const list = await engine.addSuppression((body.emails || []).map(engine.normalizeEmail).filter(engine.isValidEmail), ws);
    return http.json(res, 200, { suppressed: list.length });
  }

  return http.json(res, 400, { error: 'Unknown action' });
});
