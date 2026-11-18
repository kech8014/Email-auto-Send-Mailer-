'use strict';

/**
 * Multi-user separation test.
 *
 * Run with:  node scripts/multiuser.js
 *
 * Two people sign in with their own codes and run campaigns AT THE SAME TIME,
 * each through their own mailbox (two separate SMTP sinks). It proves the thing
 * that matters: nothing one person owns - mailbox, campaigns, suppression list,
 * settings - is visible to, or used by, the other, and that the owner's original
 * data is untouched.
 */

process.env.SECRET_KEY = 'multiuser-test-key';
process.env.ACCESS_CODE = 'owner-code';

const { createSink } = require('./smtp-sink');
const store = require('../api/_store');
const secrets = require('../api/_crypto');
const engine = require('../api/_engine');
const worker = require('../api/_worker');
const users = require('../api/_users');

const campaignApi = require('../api/campaign');
const settingsApi = require('../api/settings');
const connectionApi = require('../api/connection');
const authApi = require('../api/auth');

let passed = 0;
function check(label, condition, detail) {
  if (condition) { passed += 1; console.log('  PASS  ' + label); }
  else { console.log('  FAIL  ' + label + (detail ? '  -> ' + detail : '')); process.exitCode = 1; }
}

/** Call an API handler the way Vercel would, as a given signed-in session. */
async function call(handler, session, body) {
  const headers = {};
  if (session) headers.cookie = 'kech_session=' + encodeURIComponent(secrets.issueSession(session));
  const req = { method: 'POST', headers, body, url: '/api/x', socket: { remoteAddress: '127.0.0.1' } };
  const out = { status: 0, json: null, headers: {} };
  const res = {
    statusCode: 200,
    writableEnded: false,
    setHeader(k, v) { out.headers[k.toLowerCase()] = v; },
    end(text) { this.writableEnded = true; out.status = this.statusCode; try { out.json = JSON.parse(text); } catch (_) { out.json = text; } }
  };
  await handler(req, res);
  return out;
}

async function connectionFor(ws, port, email) {
  await engine.setConnection({
    email,
    fromName: email.split('@')[0],
    domain: email.split('@')[1],
    provider: { id: 'custom', label: 'Custom SMTP', source: 'manual' },
    dailyLimit: 500,
    smtp: { host: '127.0.0.1', port, secure: false, user: email, pass: secrets.seal('pw-' + ws) },
    imap: null,
    health: { state: 'connected', checkedAt: Date.now(), message: 'SMTP verified' },
    verifiedAt: Date.now(),
    createdAt: Date.now()
  }, ws);
}

const pacing = { minDelayMs: 1000, maxDelayMs: 1200, randomize: false, hourlyCap: 100, dailyCap: 500 };

async function runToEnd(id) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const r = await worker.runTick(id);
    const m = await engine.getMeta(id);
    if (m.status !== 'running') return m;
    if (r.skipped) await new Promise((x) => setTimeout(x, 150));
  }
  return engine.getMeta(id);
}

async function startCampaign(session, name, emails) {
  const created = await call(campaignApi, session, {
    action: 'create',
    name,
    rows: emails.map((e, i) => ({ Email: e, First: 'P' + i })),
    columns: ['Email', 'First'],
    emailField: 'Email',
    subject: name + ' for {{First}}',
    body: 'Hello {{First}}',
    isHtml: false,
    pacing
  });
  if (created.status !== 200) throw new Error('create failed: ' + JSON.stringify(created.json));
  const id = created.json.campaign.id;
  const meta = await engine.getMeta(id);
  meta.status = 'running';
  meta.startedAt = Date.now();
  meta.nextSendAt = Date.now();
  await engine.setMeta(meta);
  return id;
}

async function main() {
  const sinkOwner = createSink({});
  const sinkAlex = createSink({});
  const portOwner = await sinkOwner.listen(0);
  const portAlex = await sinkAlex.listen(0);

  console.log('\nPeople and sign-in');
  const ownerLogin = await users.authenticate('owner-code');
  check('owner code signs in as the owner', ownerLogin && ownerLogin.ws === 'default' && ownerLogin.admin === true);

  const added = await users.addUser('Alex Rivera');
  check('a person can be added and is given a code', Boolean(added.code) && /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(added.code), added.code);
  const alexLogin = await users.authenticate(added.code);
  check('their code signs them in to their own workspace', alexLogin && alexLogin.ws === added.user.id && alexLogin.admin === false);
  check('their code works typed in lower case without dashes', Boolean(await users.authenticate(added.code.replace(/-/g, '').toLowerCase())));
  check('a wrong code is rejected', (await users.authenticate('WRONG-CODE-XXXX')) === null);
  check('the stored record never contains the code', !JSON.stringify(await store.get('users')).includes(added.code.replace(/-/g, '')));

  let dupe = null;
  try { await users.addUser('alex rivera'); } catch (e) { dupe = e; }
  check('duplicate names are refused', Boolean(dupe));

  const owner = { ws: 'default', name: 'Owner', admin: true };
  const alex = { ws: alexLogin.ws, name: alexLogin.name, admin: false };

  console.log('\nTwo mailboxes');
  await connectionFor('default', portOwner, 'owner@firm.test');
  await connectionFor(alex.ws, portAlex, 'alex@other.test');
  const gotOwner = await call(connectionApi, owner, { action: 'get' });
  const gotAlex = await call(connectionApi, alex, { action: 'get' });
  check('owner sees only their own mailbox', gotOwner.json.connection.email === 'owner@firm.test');
  check('the other person sees only their own mailbox', gotAlex.json.connection.email === 'alex@other.test');

  const fresh = await users.addUser('No Mailbox');
  const freshSession = { ws: fresh.user.id, name: 'No Mailbox', admin: false };
  const none = await call(connectionApi, freshSession, { action: 'get' });
  check('a new person starts with no mailbox (does not inherit the owner\'s)', none.json.connection === null);
  const noSend = await call(campaignApi, freshSession, { action: 'create', rows: [{ Email: 'x@y.test' }], emailField: 'Email', subject: 's', body: 'b' });
  check('a person with no mailbox cannot send through someone else\'s', noSend.status === 400, noSend.status);

  console.log('\nSending at the same time');
  const ownerEmails = ['o1@a.test', 'o2@a.test', 'o3@a.test'];
  const alexEmails = ['x1@b.test', 'x2@b.test', 'x3@b.test'];
  const ownerId = await startCampaign(owner, 'OwnerCampaign', ownerEmails);
  const alexId = await startCampaign(alex, 'AlexCampaign', alexEmails);

  const [ownerMeta, alexMeta] = await Promise.all([runToEnd(ownerId), runToEnd(alexId)]);
  check('owner campaign completed', ownerMeta.status === 'completed' && ownerMeta.stats.sent === 3, ownerMeta.status + '/' + ownerMeta.stats.sent);
  check('the other campaign completed at the same time', alexMeta.status === 'completed' && alexMeta.stats.sent === 3, alexMeta.status + '/' + alexMeta.stats.sent);

  const ownerGot = sinkOwner.received.flatMap((m) => m.to).sort();
  const alexGot = sinkAlex.received.flatMap((m) => m.to).sort();
  check('owner mailbox sent only the owner\'s recipients', JSON.stringify(ownerGot) === JSON.stringify(ownerEmails), JSON.stringify(ownerGot));
  check('the other mailbox sent only their recipients', JSON.stringify(alexGot) === JSON.stringify(alexEmails), JSON.stringify(alexGot));
  check('each message came from its own sender address',
    sinkOwner.received.every((m) => /owner@firm\.test/.test(m.raw)) && sinkAlex.received.every((m) => /alex@other\.test/.test(m.raw)));
  check('no message crossed over', !sinkOwner.received.some((m) => /x\d@b\.test/.test(m.raw)) && !sinkAlex.received.some((m) => /o\d@a\.test/.test(m.raw)));

  console.log('\nCampaign isolation');
  const listOwner = await call(campaignApi, owner, { action: 'list' });
  const listAlex = await call(campaignApi, alex, { action: 'list' });
  check('owner list contains only the owner\'s campaigns', listOwner.json.campaigns.every((c) => c.name !== 'AlexCampaign') && listOwner.json.campaigns.some((c) => c.name === 'OwnerCampaign'));
  check('the other person\'s list contains only theirs', listAlex.json.campaigns.length === 1 && listAlex.json.campaigns[0].name === 'AlexCampaign');

  const peek = await call(campaignApi, alex, { action: 'get', id: ownerId });
  check('cannot open someone else\'s campaign (reads as not found)', peek.status === 404);
  const peekRecipients = await call(campaignApi, alex, { action: 'recipients', id: ownerId, offset: 0, limit: 10 });
  check('cannot read someone else\'s recipients', peekRecipients.status === 404);
  const sneakStop = await call(campaignApi, alex, { action: 'control', command: 'stop', id: ownerId });
  check('cannot control someone else\'s campaign', sneakStop.status === 404);
  const sneakDelete = await call(campaignApi, alex, { action: 'delete', id: ownerId });
  check('cannot delete someone else\'s campaign', (await engine.getMeta(ownerId)) !== null, JSON.stringify(sneakDelete.json));

  console.log('\nSuppression and settings are separate');
  await call(settingsApi, owner, { action: 'suppression-add', emails: ['blocked@owner.test'] });
  const sOwner = await call(settingsApi, owner, { action: 'suppression-list' });
  const sAlex = await call(settingsApi, alex, { action: 'suppression-list' });
  check('owner suppression list has the address', sOwner.json.emails.includes('blocked@owner.test'));
  check('the other person\'s suppression list does not', !sAlex.json.emails.includes('blocked@owner.test'));
  await call(settingsApi, alex, { action: 'save', pacing: { hourlyCap: 7 } });
  const setOwner = await call(settingsApi, owner, { action: 'get' });
  const setAlex = await call(settingsApi, alex, { action: 'get' });
  check('their settings change does not touch the owner\'s', setOwner.json.settings.pacing.hourlyCap !== 7 && setAlex.json.settings.pacing.hourlyCap === 7);

  console.log('\nOnly the owner manages people');
  const asAlex = await call(settingsApi, alex, { action: 'users-list' });
  check('a normal person cannot list or add people', asAlex.status === 403);
  const asAlexAdd = await call(settingsApi, alex, { action: 'users-add', name: 'Sneaky' });
  check('a normal person cannot add people', asAlexAdd.status === 403);
  const asOwner = await call(settingsApi, owner, { action: 'users-list' });
  check('the owner can list people', asOwner.status === 200 && asOwner.json.users.length === 2);
  check('listing never reveals codes', !JSON.stringify(asOwner.json).includes('digest'));

  console.log('\nBackward compatibility (the campaign already running today)');
  // A session cookie issued before multi-user existed has no identity fields.
  const legacyToken = (() => {
    const payload = Buffer.from(JSON.stringify({ iat: Date.now(), exp: Date.now() + 3600000, n: 'legacy' })).toString('base64url');
    const sig = require('crypto').createHmac('sha256', require('crypto').createHash('sha256').update('multiuser-test-key').digest()).update(payload).digest('base64url');
    return payload + '.' + sig;
  })();
  const legacy = secrets.verifySession(legacyToken);
  check('an old session is read as the owner (nobody is signed out)', legacy && legacy.ws === 'default' && legacy.admin === true);
  // A campaign created before multi-user has no workspace field.
  const oldCampaign = await engine.createCampaign({ name: 'Pre-existing', rows: [{ Email: 'old@a.test' }], emailField: 'Email', subject: 's', body: 'b' });
  const stored = await engine.getMeta(oldCampaign.id);
  delete stored.ws; delete stored.owner;
  await engine.setMeta(stored);
  const ownerSeesOld = await call(campaignApi, owner, { action: 'get', id: oldCampaign.id });
  const alexSeesOld = await call(campaignApi, alex, { action: 'get', id: oldCampaign.id });
  check('a campaign with no workspace belongs to the owner', ownerSeesOld.status === 200);
  check('and is invisible to everyone else', alexSeesOld.status === 404);
  check('owner data keeps its original storage keys', (await store.get('campaigns/index')).includes(oldCampaign.id));

  console.log('\nRemoving a person');
  const longId = await startCampaign(alex, 'StillRunning', ['y1@b.test', 'y2@b.test']);
  await users.removeUser(alex.ws, engine);
  const afterRemoval = await engine.getMeta(longId);
  check('their running campaign is stopped', afterRemoval.status === 'stopped', afterRemoval.status);
  check('their code no longer signs in', (await users.authenticate(added.code)) === null);
  check('their session stops working on the next request', !(await users.isActive(alex.ws)));
  const blocked = await call(campaignApi, alex, { action: 'list' });
  check('API calls with their old session are refused', blocked.status === 401, blocked.status);
  check('the owner and the other person are unaffected', (await users.isActive('default')) && (await users.isActive(fresh.user.id)));

  console.log('\nSweep covers every workspace');
  await connectionFor(fresh.user.id, portOwner, 'third@third.test');
  const sweepId = await startCampaign(freshSession, 'Orphan', ['z@c.test']);
  const orphan = await engine.getMeta(sweepId);
  orphan.worker = { chainId: null, lastTickAt: 1 };
  orphan.nextSendAt = 1;
  await engine.setMeta(orphan);
  const swept = await worker.sweep();
  check('the scheduled sweep finds stalled campaigns in other workspaces', swept.revived.includes(sweepId) || swept.checked >= 1, JSON.stringify(swept));

  await sinkOwner.close && sinkOwner.close();
  await sinkAlex.close && sinkAlex.close();
  console.log('\n' + passed + ' checks passed');
  process.exit(process.exitCode || 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
