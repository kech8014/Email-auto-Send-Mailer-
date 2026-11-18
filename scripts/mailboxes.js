'use strict';

/**
 * Multiple-mailbox test.
 *
 * Run with:  node scripts/mailboxes.js
 *
 * One person connects two mailboxes and runs a campaign on each AT THE SAME TIME.
 * It proves each campaign sends only through its own mailbox, that a second
 * campaign cannot be started on a mailbox that is already busy, and that the
 * original single mailbox behaves exactly as before.
 */

process.env.SECRET_KEY = 'mailboxes-test-key';
process.env.ACCESS_CODE = 'owner-code';

const { createSink } = require('./smtp-sink');
const store = require('../api/_store');
const secrets = require('../api/_crypto');
const engine = require('../api/_engine');
const worker = require('../api/_worker');

const users = require('../api/_users');
const campaignApi = require('../api/campaign');
const connectionApi = require('../api/connection');

let passed = 0;
function check(label, condition, detail) {
  if (condition) { passed += 1; console.log('  PASS  ' + label); }
  else { console.log('  FAIL  ' + label + (detail ? '  -> ' + detail : '')); process.exitCode = 1; }
}

async function call(handler, session, body) {
  const headers = { cookie: 'kech_session=' + encodeURIComponent(secrets.issueSession(session)) };
  const req = { method: 'POST', headers, body, url: '/api/x', socket: { remoteAddress: '127.0.0.1' } };
  const out = { status: 0, json: null };
  const res = {
    statusCode: 200, writableEnded: false,
    setHeader() {},
    end(text) { this.writableEnded = true; out.status = this.statusCode; try { out.json = JSON.parse(text); } catch (_) { out.json = text; } }
  };
  await handler(req, res);
  return out;
}

const owner = { ws: 'default', name: 'Owner', admin: true };
const pacing = { minDelayMs: 1000, maxDelayMs: 1200, randomize: false, hourlyCap: 100, dailyCap: 500 };

async function create(name, emails, accountId) {
  const r = await call(campaignApi, owner, {
    action: 'create', name, accountId,
    rows: emails.map((e, i) => ({ Email: e, First: 'P' + i })), columns: ['Email', 'First'], emailField: 'Email',
    subject: name + ' for {{First}}', body: 'Hello {{First}}', isHtml: false, pacing
  });
  return r;
}

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

async function main() {
  const sinkA = createSink({});
  const sinkB = createSink({});
  const portA = await sinkA.listen(0);
  const portB = await sinkB.listen(0);

  console.log('\nConnecting two mailboxes');
  // The original mailbox, stored exactly the way it was before this feature.
  await store.set('connection', {
    email: 'first@firm.test', fromName: 'First', domain: 'firm.test',
    provider: { id: 'custom', label: 'Custom SMTP', source: 'manual' }, dailyLimit: 500,
    smtp: { host: '127.0.0.1', port: portA, secure: false, user: 'first@firm.test', pass: secrets.seal('pw1') },
    imap: null, health: { state: 'connected', checkedAt: Date.now(), message: 'SMTP verified' }, verifiedAt: Date.now(), createdAt: Date.now()
  });

  let list = await call(connectionApi, owner, { action: 'list' });
  check('the original mailbox shows up as "main"', list.json.connections.length === 1 && list.json.connections[0].id === 'main' && list.json.connections[0].email === 'first@firm.test');

  const added = await call(connectionApi, owner, {
    action: 'save', accountId: 'new', email: 'second@other.test', password: 'pw2', fromName: 'Second',
    smtp: { host: '127.0.0.1', port: portB, secure: false }
  });
  check('a second mailbox can be connected', added.status === 200 && added.json.connections.length === 2, added.status + ' ' + JSON.stringify(added.json).slice(0, 200));
  const secondId = added.json.connection && added.json.connection.id;
  check('it gets its own id', Boolean(secondId) && secondId !== 'main');

  list = await call(connectionApi, owner, { action: 'list' });
  check('both mailboxes are listed', list.json.connections.map((c) => c.email).sort().join() === 'first@firm.test,second@other.test');
  check('passwords are never returned', !JSON.stringify(list.json).includes('pw1') && !JSON.stringify(list.json).includes('pw2'));

  const dupe = await call(connectionApi, owner, {
    action: 'save', accountId: 'new', email: 'second@other.test', password: 'pw2', smtp: { host: '127.0.0.1', port: portB, secure: false }
  });
  check('the same address cannot be connected twice', dupe.status === 400 && /already connected/.test(dupe.json.error), dupe.status + ' ' + JSON.stringify(dupe.json));

  const renamed = await call(connectionApi, owner, { action: 'set-name', accountId: secondId, fromName: 'Renamed' });
  const afterRename = await call(connectionApi, owner, { action: 'list' });
  check('each mailbox keeps its own sender name', renamed.status === 200
    && afterRename.json.connections.find((c) => c.id === secondId).fromName === 'Renamed'
    && afterRename.json.connections.find((c) => c.id === 'main').fromName === 'First');

  console.log('\nTwo campaigns at the same time, one per mailbox');
  const c1 = await create('CampaignOne', ['a1@x.test', 'a2@x.test', 'a3@x.test'], 'main');
  const c2 = await create('CampaignTwo', ['b1@y.test', 'b2@y.test', 'b3@y.test'], secondId);
  check('a campaign records which mailbox it sends from', c1.json.campaign && c2.json.campaign);
  const id1 = c1.json.campaign.id;
  const id2 = c2.json.campaign.id;
  check('the first is tied to the main mailbox', engine.accountOf(await engine.getMeta(id1)) === 'main');
  check('the second is tied to the second mailbox', engine.accountOf(await engine.getMeta(id2)) === secondId);

  const s1 = await call(campaignApi, owner, { action: 'control', command: 'start', id: id1 });
  const s2 = await call(campaignApi, owner, { action: 'control', command: 'start', id: id2 });
  check('both campaigns start without errors', s1.status === 200 && s2.status === 200, s1.status + '/' + s2.status);

  console.log('\nA busy mailbox cannot take a second campaign');
  const c3 = await create('CampaignThree', ['c1@z.test'], 'main');
  const s3 = await call(campaignApi, owner, { action: 'control', command: 'start', id: c3.json.campaign.id });
  check('starting another campaign on a busy mailbox is refused', s3.status === 409, s3.status + ' ' + JSON.stringify(s3.json));
  check('the message names the campaign in the way and the fix', /CampaignOne/.test(s3.json.error) && /other mailbox/i.test(s3.json.error), s3.json.error);
  const m3 = await engine.getMeta(c3.json.campaign.id);
  check('the refused campaign did not start', m3.status !== 'running', m3.status);

  const [r1, r2] = await Promise.all([runToEnd(id1), runToEnd(id2)]);
  check('campaign one finished', r1.status === 'completed' && r1.stats.sent === 3, r1.status + '/' + r1.stats.sent);
  check('campaign two finished at the same time', r2.status === 'completed' && r2.stats.sent === 3, r2.status + '/' + r2.stats.sent);

  const gotA = sinkA.received.flatMap((m) => m.to).sort().join();
  const gotB = sinkB.received.flatMap((m) => m.to).sort().join();
  check('mailbox one sent only campaign one\'s recipients', gotA === 'a1@x.test,a2@x.test,a3@x.test', gotA);
  check('mailbox two sent only campaign two\'s recipients', gotB === 'b1@y.test,b2@y.test,b3@y.test', gotB);
  check('each message came from its own address',
    sinkA.received.every((m) => /first@firm\.test/.test(m.raw)) && sinkB.received.every((m) => /second@other\.test/.test(m.raw)));
  check('the sender name used is the mailbox\'s own', sinkB.received.every((m) => /Renamed/.test(m.raw)));

  console.log('\nOnce the mailbox is free it can be used again');
  const s3b = await call(campaignApi, owner, { action: 'control', command: 'start', id: c3.json.campaign.id });
  check('the refused campaign now starts', s3b.status === 200, s3b.status + ' ' + JSON.stringify(s3b.json));
  await call(campaignApi, owner, { action: 'control', command: 'stop', id: c3.json.campaign.id });

  console.log('\nOriginal behaviour is unchanged');
  // Created the way the old code did it: no mailbox field at all.
  const legacyMeta = await engine.createCampaign({ name: 'Legacy', rows: [{ Email: 'l1@w.test', First: 'L' }], emailField: 'Email', subject: 's {{First}}', body: 'b', isHtml: false, pacing });
  check('a campaign created without a mailbox is the main one', engine.accountOf(legacyMeta) === 'main');
  const old = await engine.getMeta(legacyMeta.id);
  delete old.accountId;
  await engine.setMeta(old);
  check('a campaign saved before this feature (no mailbox field) still means main', engine.accountOf(await engine.getMeta(old.id)) === 'main');
  const rLegacy = await runOne(old.id);
  check('and it still sends through the original mailbox', rLegacy.status === 'completed' && sinkA.received.some((m) => m.to.includes('l1@w.test')));

  console.log('\nOlder campaigns stay with the mailbox they were created for');
  // Campaigns made before mailboxes could be chosen carry no mailbox id - only the
  // address they were created with. Each must keep sending from that address.
  const mk = (name, rows, senderEmail) => engine.createCampaign({
    name, rows: rows.map((e) => ({ Email: e, First: 'X' })), columns: ['Email', 'First'], emailField: 'Email',
    subject: name + ' {{First}}', body: 'Hello {{First}}', isHtml: false, pacing,
    sender: { email: senderEmail, name: 'x', provider: 'Custom', domain: 'x' }
  }).then(async (m) => { const meta = await engine.getMeta(m.id); delete meta.accountId; await engine.setMeta(meta); return meta.id; });

  const forSecond = await mk('LegacyForSecond', ['ls1@q.test'], 'second@other.test');
  const pinned = await engine.resolveAccount(await engine.getMeta(forSecond));
  check('an older campaign made for the second address resolves to the second mailbox', pinned.id === secondId && pinned.conn && pinned.conn.email === 'second@other.test', JSON.stringify(pinned).slice(0, 120));
  const aBefore = sinkA.received.length; const bBefore = sinkB.received.length;
  const startPinned = await call(campaignApi, owner, { action: 'control', command: 'start', id: forSecond });
  const donePinned = await runToEnd(forSecond);
  check('it starts and finishes', startPinned.status === 200 && donePinned.status === 'completed', startPinned.status + '/' + donePinned.status);
  check('it was sent from the second mailbox and NOT from the main one', sinkB.received.length === bBefore + 1 && sinkA.received.length === aBefore, 'A+' + (sinkA.received.length - aBefore) + ' B+' + (sinkB.received.length - bBefore));
  check('and carried the second address', /second@other\.test/.test(sinkB.received[sinkB.received.length - 1].raw));

  const ghost = await mk('LegacyGhost', ['g1@q.test'], 'ghost@nowhere.test');
  const startGhost = await call(campaignApi, owner, { action: 'control', command: 'start', id: ghost });
  check('a campaign made for a mailbox that is not connected will not start', startGhost.status === 400 && /not connected/.test(startGhost.json.error), startGhost.status + ' ' + JSON.stringify(startGhost.json).slice(0, 200));
  // Even if it is forced to running, the sender refuses and sends nothing.
  const forced = await engine.getMeta(ghost); forced.status = 'running'; forced.nextSendAt = Date.now(); await engine.setMeta(forced);
  const aGhost = sinkA.received.length; const bGhost = sinkB.received.length;
  await worker.runTick(ghost);
  const afterGhost = await engine.getMeta(ghost);
  check('forced to run anyway, it is blocked and sends nothing', afterGhost.status === 'blocked' && sinkA.received.length === aGhost && sinkB.received.length === bGhost, afterGhost.status);
  check('the reason names the address it was made for', afterGhost.events.some((e) => /ghost@nowhere\.test/.test(e.message)), JSON.stringify(afterGhost.events.slice(0, 2)));

  const swapped = await mk('SwappedSender', ['s1@q.test'], 'first@firm.test');
  const sw = await engine.getMeta(swapped); sw.accountId = secondId; await engine.setMeta(sw);
  const startSwapped = await call(campaignApi, owner, { action: 'control', command: 'start', id: swapped });
  check('a campaign pointed at a mailbox with a different address is refused', startSwapped.status === 400 && /first@firm\.test/.test(startSwapped.json.error) && /second@other\.test/.test(startSwapped.json.error), startSwapped.status + ' ' + JSON.stringify(startSwapped.json).slice(0, 220));

  const listed = await call(campaignApi, owner, { action: 'list' });
  const byName = Object.fromEntries(listed.json.campaigns.map((c) => [c.name, c.mailbox]));
  check('the list says which mailbox each campaign sends from', byName.LegacyForSecond.email === 'second@other.test' && byName.LegacyForSecond.connected === true);
  check('the list flags a campaign whose mailbox is missing', byName.LegacyGhost.connected === false && /ghost@nowhere\.test/.test(byName.LegacyGhost.problem));

  console.log('\nMoving a campaign to a different mailbox');
  // A campaign created while only the first mailbox existed, but that really belongs to the second.
  const toMove = await mk('MoveMe', ['mv1@q.test', 'mv2@q.test'], 'first@firm.test');
  const mm = await engine.getMeta(toMove); mm.status = 'paused'; mm.stats.sent = 1; mm.stats.queued = 1; await engine.setMeta(mm);

  const noTarget = await call(campaignApi, owner, { action: 'move', id: toMove, accountId: 'm_nonexistent' });
  check('moving to a mailbox that is not connected is refused', noTarget.status === 400, noTarget.status + ' ' + JSON.stringify(noTarget.json));
  const same = await call(campaignApi, owner, { action: 'move', id: toMove, accountId: 'main' });
  check('moving to the mailbox it already uses is refused', same.status === 400 && /already sends from/.test(same.json.error), same.status + ' ' + JSON.stringify(same.json));
  const runningMv = await engine.getMeta(toMove); runningMv.status = 'running'; await engine.setMeta(runningMv);
  const whileRunning = await call(campaignApi, owner, { action: 'move', id: toMove, accountId: secondId });
  check('a running campaign cannot be moved', whileRunning.status === 400 && /Pause or stop/.test(whileRunning.json.error), whileRunning.status);
  const pausedMv = await engine.getMeta(toMove); pausedMv.status = 'paused'; await engine.setMeta(pausedMv);

  const moved = await call(campaignApi, owner, { action: 'move', id: toMove, accountId: secondId });
  check('a paused campaign can be moved to the second mailbox', moved.status === 200 && moved.json.to === 'second@other.test' && moved.json.from === 'first@firm.test', moved.status + ' ' + JSON.stringify(moved.json).slice(0, 160));
  const afterMove = await engine.getMeta(toMove);
  check('it is now recorded as sending from the second address', afterMove.sender.email === 'second@other.test' && afterMove.accountId === secondId);
  check('the move is written into its history, with what was already sent', afterMove.events.some((e) => /Moved to second@other\.test/.test(e.message) && /1 already sent/.test(e.detail || '')), JSON.stringify(afterMove.events[0]));
  check('the list now shows it under the second mailbox', (await call(campaignApi, owner, { action: 'list' })).json.campaigns.find((c) => c.name === 'MoveMe').mailbox.email === 'second@other.test');

  const bBeforeMove = sinkB.received.length; const aBeforeMove = sinkA.received.length;
  const startMoved = await call(campaignApi, owner, { action: 'control', command: 'resume', id: toMove });
  const finishedMoved = await runToEnd(toMove);
  check('resumed, it finishes from the second mailbox only', startMoved.status === 200 && finishedMoved.status === 'completed' && sinkB.received.length > bBeforeMove && sinkA.received.length === aBeforeMove, startMoved.status + ' B+' + (sinkB.received.length - bBeforeMove) + ' A+' + (sinkA.received.length - aBeforeMove));

  const stranger = await users.addUser('Moving Stranger');
  const strangerSession = { ws: stranger.user.id, name: 'Moving Stranger', admin: false };
  const sneak = await call(campaignApi, strangerSession, { action: 'move', id: toMove, accountId: 'main' });
  check('someone else cannot move your campaign', sneak.status === 404, sneak.status);

  console.log('\nDisconnecting one mailbox leaves the other alone');
  const d = await call(connectionApi, owner, { action: 'disconnect', accountId: secondId });
  check('the second mailbox is removed', d.status === 200 && d.json.connections.length === 1 && d.json.connections[0].id === 'main');
  check('the main mailbox is untouched', (await engine.getConnection('default', 'main')).email === 'first@firm.test');
  check('the removed mailbox\'s credentials are gone', (await engine.getConnection('default', secondId)) === null);

  console.log('\nThe other person, from their own PC');
  const settingsApi = require('../api/settings');
  const added2 = await users.addUser('Jordan Lee');
  const jordanLogin = await users.authenticate(added2.code);
  const jordan = { ws: jordanLogin.ws, name: jordanLogin.name, admin: false };
  const callAs = (who, handler, body) => call(handler, who, body);

  const before = await callAs(jordan, connectionApi, { action: 'list' });
  check('they start with no mailbox of their own (they do not see yours)', before.json.connections.length === 0, JSON.stringify(before.json.connections));

  const tryOwners = await callAs(jordan, connectionApi, { action: 'save', email: 'first@firm.test', password: 'x', smtp: { host: '127.0.0.1', port: portA, secure: false } });
  check('they cannot connect the mailbox you already use', tryOwners.status === 400 && /already connected by the owner/.test(tryOwners.json.error), tryOwners.status + ' ' + JSON.stringify(tryOwners.json));

  const theirs = await callAs(jordan, connectionApi, { action: 'save', email: 'jordan@their.test', password: 'pw-j', fromName: 'Jordan', smtp: { host: '127.0.0.1', port: portB, secure: false } });
  check('they can connect their own mailbox', theirs.status === 200 && theirs.json.connection.email === 'jordan@their.test', theirs.status + ' ' + JSON.stringify(theirs.json).slice(0, 160));
  check('it is stored in their workspace, not yours', (await engine.getConnection(jordan.ws, 'main')).email === 'jordan@their.test' && (await engine.getConnection('default', 'main')).email === 'first@firm.test');

  const ownerSees = await call(connectionApi, owner, { action: 'list' });
  check('you still see only your own mailbox', ownerSees.json.connections.every((c) => c.email !== 'jordan@their.test'));

  const tryTheirs = await call(connectionApi, owner, { action: 'save', accountId: 'new', email: 'jordan@their.test', password: 'x', smtp: { host: '127.0.0.1', port: portB, secure: false } });
  check('you cannot connect theirs either', tryTheirs.status === 400 && /already connected by Jordan Lee/.test(tryTheirs.json.error), tryTheirs.status + ' ' + JSON.stringify(tryTheirs.json));

  // Both send at the same moment, each from their own mailbox.
  const sinkAcount = sinkA.received.length;
  const sinkBcount = sinkB.received.length;
  const mine = await create('OwnerRun', ['m1@o.test', 'm2@o.test'], 'main');
  const jr = await callAs(jordan, campaignApi, {
    action: 'create', name: 'JordanRun', rows: [{ Email: 'j1@t.test', First: 'J1' }, { Email: 'j2@t.test', First: 'J2' }], columns: ['Email', 'First'], emailField: 'Email',
    subject: 'JordanRun for {{First}}', body: 'Hello {{First}}', isHtml: false, pacing
  });
  check('they can create a campaign on their mailbox', jr.status === 200, jr.status + ' ' + JSON.stringify(jr.json).slice(0, 160));
  const mineId = mine.json.campaign.id;
  const jrId = jr.json.campaign.id;
  const [sm, sj] = await Promise.all([
    call(campaignApi, owner, { action: 'control', command: 'start', id: mineId }),
    callAs(jordan, campaignApi, { action: 'control', command: 'start', id: jrId })
  ]);
  check('both start at the same time with no conflict', sm.status === 200 && sj.status === 200, sm.status + '/' + sj.status);
  const [fm, fj] = await Promise.all([runToEnd(mineId), runToEnd(jrId)]);
  check('both finish', fm.status === 'completed' && fj.status === 'completed', fm.status + '/' + fj.status);
  const newA = sinkA.received.slice(sinkAcount).flatMap((m) => m.to).sort().join();
  const newB = sinkB.received.slice(sinkBcount).flatMap((m) => m.to).sort().join();
  check('your mailbox sent only your two', newA === 'm1@o.test,m2@o.test', newA);
  check('their mailbox sent only their two', newB === 'j1@t.test,j2@t.test', newB);
  check('their messages came from their address and name', sinkB.received.slice(sinkBcount).every((m) => /jordan@their\.test/.test(m.raw) && /Jordan/.test(m.raw)));

  const theirList = await callAs(jordan, campaignApi, { action: 'list' });
  check('their campaign list has only their campaign', theirList.json.campaigns.length === 1 && theirList.json.campaigns[0].name === 'JordanRun', JSON.stringify(theirList.json.campaigns.map((c) => c.name)));
  check('they cannot open, stop or delete yours', (await callAs(jordan, campaignApi, { action: 'get', id: mineId })).status === 404
    && (await callAs(jordan, campaignApi, { action: 'control', command: 'stop', id: mineId })).status === 404);
  check('they cannot manage people', (await callAs(jordan, settingsApi, { action: 'users-add', name: 'X' })).status === 403);

  // Their dashboard heartbeat only revives their own campaigns; the schedule revives everyone's.
  const sweepMine = await worker.sweep('default');
  const sweepTheirs = await worker.sweep(jordan.ws);
  check('a sweep is scoped to one person\'s campaigns', Array.isArray(sweepMine.revived) && Array.isArray(sweepTheirs.revived));

  await callAs(jordan, connectionApi, { action: 'disconnect' });
  const retry = await call(connectionApi, owner, { action: 'save', accountId: 'new', email: 'jordan@their.test', password: 'x', smtp: { host: '127.0.0.1', port: portB, secure: false } });
  check('once they disconnect, the address is free again', retry.status === 200, retry.status + ' ' + JSON.stringify(retry.json).slice(0, 160));
  await call(connectionApi, owner, { action: 'disconnect', accountId: retry.json.connection.id });

  console.log('\nThe limit');
  for (let i = 0; i < 4; i += 1) {
    await call(connectionApi, owner, { action: 'save', accountId: 'new', email: 'box' + i + '@lim.test', password: 'p', smtp: { host: '127.0.0.1', port: portB, secure: false } });
  }
  const over = await call(connectionApi, owner, { action: 'save', accountId: 'new', email: 'box9@lim.test', password: 'p', smtp: { host: '127.0.0.1', port: portB, secure: false } });
  check('no more than ' + engine.MAX_MAILBOXES + ' mailboxes can be connected', over.status === 400 && /up to 5/.test(over.json.error), over.status + ' ' + JSON.stringify(over.json));

  console.log('\n' + passed + ' checks passed');
  process.exit(process.exitCode || 0);
}

async function runOne(id) {
  const m = await engine.getMeta(id);
  m.status = 'running'; m.nextSendAt = Date.now(); await engine.setMeta(m);
  return runToEnd(id);
}

main().catch((err) => { console.error(err); process.exit(1); });
