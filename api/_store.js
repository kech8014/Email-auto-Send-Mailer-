'use strict';

/**
 * Persistence abstraction. Campaign state must outlive any single request, so
 * everything the worker needs is written here after every state transition.
 *
 * Drivers, in order of preference:
 *   redis  - Upstash/Vercel KV REST. Strongly consistent; the right choice for
 *            production because the worker reads its own writes immediately.
 *   blob   - Vercel Blob. Zero provisioning, good enough for a single-writer
 *            campaign chain; reads bypass the CDN cache explicitly.
 *   memory - Local dev only. State dies with the process.
 */

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const HAS_REDIS = Boolean(REDIS_URL && REDIS_TOKEN);
const HAS_BLOB = Boolean(process.env.BLOB_READ_WRITE_TOKEN);

const driver = HAS_REDIS ? 'redis' : HAS_BLOB ? 'blob' : 'memory';
const memory = globalThis.__kechMemoryStore || (globalThis.__kechMemoryStore = new Map());

async function redisCmd(command) {
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command)
  });
  if (!res.ok) throw new Error(`Store error ${res.status}: ${await res.text()}`);
  return (await res.json()).result;
}

const KEY_PREFIX = 'kech/';
const blobKey = (key) => `${KEY_PREFIX}${key}.json`;

async function blobGet(key) {
  const { head } = require('@vercel/blob');
  try {
    const meta = await head(blobKey(key));
    // Bypass the edge cache so the worker always reads its own latest write.
    const res = await fetch(`${meta.url}?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    // A key that was never written is a miss, not a failure. Match on the error
    // class first: the SDK's message wording ("The requested blob does not
    // exist") is not stable enough to detect on its own.
    const name = String((err && err.name) || '');
    const message = String((err && err.message) || '');
    if (name === 'BlobNotFoundError' || /not ?found|does not exist/i.test(message)) return null;
    throw err;
  }
}

async function blobSet(key, value) {
  const { put } = require('@vercel/blob');
  await put(blobKey(key), JSON.stringify(value), {
    access: 'public',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 0
  });
}

async function get(key) {
  if (driver === 'redis') {
    const raw = await redisCmd(['GET', KEY_PREFIX + key]);
    return raw ? JSON.parse(raw) : null;
  }
  if (driver === 'blob') return blobGet(key);
  const raw = memory.get(key);
  return raw ? JSON.parse(raw) : null;
}

async function set(key, value) {
  if (driver === 'redis') return void (await redisCmd(['SET', KEY_PREFIX + key, JSON.stringify(value)]));
  if (driver === 'blob') return blobSet(key, value);
  memory.set(key, JSON.stringify(value));
}

async function del(key) {
  if (driver === 'redis') return void (await redisCmd(['DEL', KEY_PREFIX + key]));
  if (driver === 'blob') {
    const { del: blobDel } = require('@vercel/blob');
    try { await blobDel(blobKey(key)); } catch (_) {}
    return;
  }
  memory.delete(key);
}

/** Index of campaign ids, newest first. Kept small and separate from bodies. */
async function listCampaignIds() {
  return (await get('campaigns/index')) || [];
}

async function indexCampaign(id) {
  const ids = await listCampaignIds();
  const next = [id, ...ids.filter((x) => x !== id)].slice(0, 200);
  await set('campaigns/index', next);
}

async function unindexCampaign(id) {
  await set('campaigns/index', (await listCampaignIds()).filter((x) => x !== id));
}

/**
 * Best-effort mutex so two overlapping worker chains cannot send the same
 * message twice. Redis gives a real atomic lock; other drivers get a
 * timestamp-based lease, which is sufficient because the chain is single-writer.
 */
async function acquireLock(name, ttlMs = 90000) {
  const key = `lock/${name}`;
  const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  if (driver === 'redis') {
    const ok = await redisCmd(['SET', KEY_PREFIX + key, token, 'NX', 'PX', String(ttlMs)]);
    return ok ? token : null;
  }
  const current = await get(key);
  if (current && current.until > Date.now()) return null;
  await set(key, { token, until: Date.now() + ttlMs });
  return token;
}

async function releaseLock(name, token) {
  const key = `lock/${name}`;
  if (driver === 'redis') {
    const current = await redisCmd(['GET', KEY_PREFIX + key]);
    if (current === token) await redisCmd(['DEL', KEY_PREFIX + key]);
    return;
  }
  const current = await get(key);
  if (current && current.token === token) await del(key);
}

module.exports = { get, set, del, driver, listCampaignIds, indexCampaign, unindexCampaign, acquireLock, releaseLock, durable: driver !== 'memory' };
