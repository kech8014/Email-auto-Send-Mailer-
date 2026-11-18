'use strict';

const crypto = require('crypto');
const store = require('./_store');
const secrets = require('./_crypto');

/**
 * People who can sign in and run their own campaigns.
 *
 * The owner signs in with ACCESS_CODE and works in the "default" workspace (the
 * original data, untouched). Everyone else is added from Settings, is given their
 * own code, and works in a private workspace: their own mailbox, settings,
 * suppression list and campaigns. Several people can be signed in and sending at
 * the same time, because nothing a workspace owns is shared.
 */

const USERS_KEY = 'users';
const MAX_USERS = 25;
const ACTIVE_CACHE_MS = 30000;

let cache = { at: 0, list: null };

function clean(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

async function readAll(fresh) {
  if (!fresh && cache.list && Date.now() - cache.at < ACTIVE_CACHE_MS) return cache.list;
  const list = (await store.get(USERS_KEY)) || [];
  cache = { at: Date.now(), list };
  return list;
}

async function writeAll(list) {
  await store.set(USERS_KEY, list);
  cache = { at: Date.now(), list };
}

/** Public view: never includes the code digest. */
function view(u) {
  return { id: u.id, name: u.name, createdAt: u.createdAt };
}

async function listUsers() {
  return (await readAll(true)).map(view);
}

function slug(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
}

async function addUser(name) {
  const display = String(name || '').trim().slice(0, 60);
  if (!display) throw Object.assign(new Error('Enter a name for the person'), { statusCode: 400 });

  const list = await readAll(true);
  if (list.length >= MAX_USERS) throw Object.assign(new Error('User limit reached'), { statusCode: 400 });
  if (list.some((u) => u.name.toLowerCase() === display.toLowerCase())) {
    throw Object.assign(new Error('Someone with that name already exists'), { statusCode: 400 });
  }

  const id = 'u_' + (slug(display) || 'user') + '_' + crypto.randomBytes(3).toString('hex');
  const code = secrets.generateCode();
  const record = { id, name: display, digest: secrets.codeDigest(clean(code)), createdAt: Date.now() };
  await writeAll([...list, record]);
  return { user: view(record), code };
}

async function resetCode(id) {
  const list = await readAll(true);
  const user = list.find((u) => u.id === id);
  if (!user) throw Object.assign(new Error('Person not found'), { statusCode: 404 });
  const code = secrets.generateCode();
  user.digest = secrets.codeDigest(clean(code));
  await writeAll(list);
  return { user: view(user), code };
}

/**
 * Remove a person. Their sign-in stops working immediately, and any campaign
 * they still have running is stopped so it cannot keep sending with nobody
 * accountable for it. Their data is kept, so an owner can still review it.
 */
async function removeUser(id, engine) {
  const list = await readAll(true);
  const user = list.find((u) => u.id === id);
  if (!user) throw Object.assign(new Error('Person not found'), { statusCode: 404 });

  let stopped = 0;
  for (const cid of await store.listCampaignIds(id)) {
    const meta = await engine.getMeta(cid);
    if (meta && meta.status === 'running') {
      meta.status = 'stopped';
      meta.nextSendAt = null;
      engine.pushEvent(meta, 'campaign', 'Campaign stopped - ' + user.name + ' was removed');
      await engine.setMeta(meta);
      stopped += 1;
    }
  }
  await writeAll(list.filter((u) => u.id !== id));
  return { removed: view(user), stoppedCampaigns: stopped };
}

/**
 * Work out who a supplied code belongs to.
 * Returns the claims for a session, or null. Compares every candidate so the
 * time taken does not reveal which code was close.
 */
async function authenticate(code) {
  if (secrets.codeMatches(code)) return { ws: 'default', name: 'Owner', admin: true };

  const digest = secrets.codeDigest(clean(code));
  const list = await readAll(true);
  let found = null;
  for (const u of list) {
    if (secrets.digestsMatch(u.digest, digest)) found = u;
  }
  if (!found) return null;
  // Deliberately no write here: rewriting the people list on every sign-in could
  // overwrite a person being added at the same moment.
  return { ws: found.id, name: found.name, admin: false };
}

/** Is this session's person still allowed in? The owner always is. */
async function isActive(ws) {
  if (!ws || ws === store.DEFAULT_WS) return true;
  return (await readAll(false)).some((u) => u.id === ws);
}

/** Every workspace that can own campaigns - used by the background sweep. */
async function allWorkspaces() {
  const list = await readAll(false);
  return [store.DEFAULT_WS, ...list.map((u) => u.id)];
}

module.exports = { listUsers, addUser, resetCode, removeUser, authenticate, isActive, allWorkspaces };
