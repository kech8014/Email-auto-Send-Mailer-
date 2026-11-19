'use strict';

/**
 * Scheduled start test.
 *
 * Run with:  node scripts/schedule.js
 *
 * A campaign can be scheduled to start at a chosen time. Until then it holds its
 * mailbox and sends nothing; at that moment it becomes a running campaign and
 * sends. Nothing else can start on the same mailbox in between, a schedule can be
 * cancelled, and a sweep wakes a scheduled campaign whose chain has been lost.
 */

process.env.SECRET_KEY = 'schedule-test-key';
process.env.ACCESS_CODE = 'owner-code';

const { createSink } = require('./smtp-sink');
const secrets = require('../api/_crypto');
const engine = require('../api/_engine');
const worker = require('../api/_worker');
const campaignApi = require('../api/campaign');

let passed = 0;
function check(label, condition, detail) {
  if (condition) { passed += 1; console.log('  PASS  ' + label); }
  else { console.log('  FAIL  ' + label + (detail ? '  -> ' + detail : '')); process.exitCode = 1; }
}

async function call(session, body) {
  const headers = { cookie: 'kech_session=' + encodeURIComponent(secrets.issueSession(session)) };
  const req = { method: 'POST', headers, body, url: '/api/campaign', socket: { remoteAddress: '127.0.0.1' } };
  const out = { status: 0, json: null };
  const res = { statusCode: 200, writableEnded: false, setHeader() {}, end(t) { this.writableEnded = true; out.status = this.statusCode; try { out.json = JSON.parse(t); } catch (_) { out.json = t; } } };
  await campaignApi(req, res);
  return out;
}

const owner = { ws: 'default', name: 'Owner', admin: true };
const pacing = { minDelayMs: 1000, maxDelayMs: 1200, randomize: false, hourlyCap: 100, dailyCap: 500 };
const make = (name, n) => call(owner, {
  action: 'create', name, accountId: 'main', rows: Array.from({ length: n }, (_, i) => ({ Email: name.toLowerCase() + i + '@x.test', First: 'X' })),
  columns: ['Email', 'First'], emailField: 'Email', subject: 's {{First}}', body: 'b', isHtml: false, pacing
}).then((r) => r.json.campaign.id);

async function main() {
  const sink = createSink({});
  const port = await sink.listen(0);
  await engine.setConnection({
    email: 's@firm.test', fromName: 'S', domain: 'firm.test',
    provider: { id: 'custom', label: 'Custom SMTP', source: 'manual' }, dailyLimit: 500,
    smtp: { host: '127.0.0.1', port, secure: false, user: 's@firm.test', pass: secrets.seal('pw') },
    imap: null, health: { state: 'connected', checkedAt: Date.now(), message: 'ok' }, verifiedAt: Date.now(), createdAt: Date.now()
  }, 'default', 'main');

  console.log('\nScheduling');
  const a = await make('Alpha', 3);
  const past = await call(owner, { action: 'control', command: 'schedule', id: a, startAt: Date.now() - 1000 });
  check('a time in the past is refused', past.status === 400, past.status);
  const far = await call(owner, { action: 'control', command: 'schedule', id: a, startAt: Date.now() + 40 * 86400000 });
  check('a time more than 30 days ahead is refused', far.status === 400, far.status);

  const startAt = Date.now() + 4000;
  const sch = await call(owner, { action: 'control', command: 'schedule', id: a, startAt });
  check('a ready campaign can be scheduled', sch.status === 200 && sch.json.campaign.status === 'scheduled', sch.status + ' ' + JSON.stringify(sch.json).slice(0, 160));
  check('the list reports the start time', (await call(owner, { action: 'list' })).json.campaigns.find((c) => c.id === a).scheduledStartAt === startAt);

  console.log('\nIt holds the mailbox');
  const b = await make('Bravo', 2);
  const blocked = await call(owner, { action: 'control', command: 'start', id: b });
  check('nothing else can start on the same mailbox while it is scheduled', blocked.status === 409 && /already sending/.test(blocked.json.error), blocked.status + ' ' + JSON.stringify(blocked.json).slice(0, 120));
  check('and it has sent nothing yet', sink.received.length === 0);

  console.log('\nThe time comes');
  const result = await worker.runTick(a);        // waits out the 4 seconds, then starts
  const meta = await engine.getMeta(a);
  check('it started by itself at the scheduled time', sink.received.length >= 1 && Date.now() >= startAt, 'delivered ' + sink.received.length);
  check('it is now an ordinary running or finished campaign', ['running', 'completed'].includes(meta.status), meta.status);
  check('the schedule is cleared and the start is recorded', !meta.scheduledStartAt && meta.events.some((e) => /Scheduled start reached/.test(e.message)));
  check('all three were sent', meta.stats.sent === 3, String(meta.stats.sent));

  console.log('\nCancelling and a lost chain');
  const c = await make('Charlie', 2);
  await call(owner, { action: 'control', command: 'schedule', id: c, startAt: Date.now() + 3600000 });
  const cancel = await call(owner, { action: 'control', command: 'stop', id: c });
  check('stopping a scheduled campaign cancels the schedule', cancel.status === 200 && (await engine.getMeta(c)).status === 'stopped' && !(await engine.getMeta(c)).scheduledStartAt);

  const d = await make('Delta', 1);
  await call(owner, { action: 'control', command: 'schedule', id: d, startAt: Date.now() + 3500 });
  const dm = await engine.getMeta(d); dm.worker = { chainId: null, lastTickAt: 1 }; await engine.setMeta(dm);   // chain "lost"
  await new Promise((r) => setTimeout(r, 4000));
  const swept = await worker.sweep();
  check('a sweep wakes a scheduled campaign whose time has come', swept.revived.includes(d), JSON.stringify(swept));

  const sent = await worker.runTick(d);
  check('and it then starts and sends', (await engine.getMeta(d)).stats.sent === 1, JSON.stringify(sent));

  console.log('\n' + passed + ' checks passed');
  process.exit(process.exitCode || 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
