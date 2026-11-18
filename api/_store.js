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

/**
 * Workspaces. Every person who signs in works inside their own workspace: their
 * own mailbox connection, settings, suppression list and campaign index, so two
 * people can run campaigns at the same time without touching each other's data.
 *
 * The original single-tenant data lives in the "default" workspace and keeps its
 * original, un-prefixed keys. That is deliberate - it means turning multi-user on
 * moves nothing, so a campaign that is already running is not disturbed.
 */
const DEFAULT_WS = 'default';

function nsKey(ws, name) {
  return !ws || ws === DEFAULT_WS ? name : `ws/${ws}/${name}`;
}

/** Index of campaign ids, newest first. Kept small and separate from bodies. */
async function listCampaignIds(ws) {
  return (await get(nsKey(ws, 'campaigns/index'))) || [];
}

/**
 * The index is one stored list, changed by read-modify-write. Two people creating
 * a campaign at the same moment could each read the old list and each write back
 * a list missing the other's entry - the campaign would still exist but vanish
 * from every screen. So every change to an index runs under a lock, taking turns.
 */
const indexTurns = new Map();

async function withIndexLock(ws, fn) {
  const name = 'index-' + (ws || DEFAULT_WS);

  // Within one server instance, take turns in order. (A lock read-then-written
  // over the network is not atomic against requests in the same process.)
  const previous = indexTurns.get(name) || Promise.resolve();
  const run = previous.then(async () => {
    // Across instances, take turns through the store's own lock.
    let token = null;
    for (let attempt = 0; attempt < 60 && !token; attempt += 1) {
      token = await acquireLock(name, 15000);
      if (!token) await new Promise((r) => setTimeout(r, 100 + Math.floor(Math.random() * 100)));
    }
    // If the lock is somehow stuck, still do the work: a missed lock is a small
    // risk, a campaign that cannot be listed at all is a worse one.
    try { return await fn(); } finally { if (token) await releaseLock(name, token); }
  });
  indexTurns.set(name, run.catch(() => {}));
  return run;
}

async function indexCampaign(id, ws) {
  return withIndexLock(ws, async () => {
    const ids = await listCampaignIds(ws);
    // No size cap: dropping an id would hide a campaign that is still sending.
    await set(nsKey(ws, 'campaigns/index'), [id, ...ids.filter((x) => x !== id)]);
  });
}

async function unindexCampaign(id, ws) {
  return withIndexLock(ws, async () => {
    await set(nsKey(ws, 'campaigns/index'), (await listCampaignIds(ws)).filter((x) => x !== id));
  });
}

/**
 * Every key that starts with a prefix, so campaigns that were saved but fell out
 * of an index can be found again. Returns null when the driver cannot list.
 */
async function scanKeys(prefix) {
  if (driver === 'redis') {
    const keys = [];
    let cursor = '0';
    do {
      const reply = await redisCmd(['SCAN', cursor, 'MATCH', KEY_PREFIX + prefix + '*', 'COUNT', '500']);
      cursor = String(reply[0]);
      keys.push(...reply[1]);
    } while (cursor !== '0');
    return keys.map((k) => k.slice(KEY_PREFIX.length));
  }
  if (driver === 'blob') {
    const { list } = require('@vercel/blob');
    const keys = [];
    let cursor;
    do {
      const page = await list({ prefix: KEY_PREFIX + prefix, cursor, limit: 1000 });
      for (const b of page.blobs) keys.push(b.pathname.slice(KEY_PREFIX.length).replace(/\.json$/, ''));
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    return keys;
  }
  return [...memory.keys()].filter((k) => k.startsWith(prefix));
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

module.exports = { get, set, del, driver, DEFAULT_WS, nsKey, scanKeys, listCampaignIds, indexCampaign, unindexCampaign, acquireLock, releaseLock, durable: driver !== 'memory' };
