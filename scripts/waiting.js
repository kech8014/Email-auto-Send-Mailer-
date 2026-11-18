'use strict';

/**
 * Waiting test.
 *
 * Run with:  node scripts/waiting.js
 *
 * When the next send is further away than one work cycle can wait, the worker must
 * sit out the cycle and hand off ONCE at the end. It used to hand off immediately -
 * to a cycle that found the same thing and did the same - so a long gap turned into
 * dozens of back-to-back hand-offs, and losing any one of them silenced the
 * campaign. Here the gap is 120 seconds: the cycle must stay alive for most of its
 * budget instead of returning at once, announce that it is alive, and leave the
 * next send time untouched.
 */

process.env.SECRET_KEY = 'waiting-test-key';
process.env.ACCESS_CODE = 'owner-code';

const { createSink } = require('./smtp-sink');
const secrets = require('../api/_crypto');
const engine = require('../api/_engine');
const worker = require('../api/_worker');

let passed = 0;
function check(label, condition, detail) {
  if (condition) { passed += 1; console.log('  PASS  ' + label); }
  else { console.log('  FAIL  ' + label + (detail ? '  -> ' + detail : '')); process.exitCode = 1; }
}

async function main() {
  const sink = createSink({});
  const port = await sink.listen(0);
  await engine.setConnection({
    email: 'w@firm.test', fromName: 'W', domain: 'firm.test',
    provider: { id: 'custom', label: 'Custom SMTP', source: 'manual' }, dailyLimit: 500,
    smtp: { host: '127.0.0.1', port, secure: false, user: 'w@firm.test', pass: secrets.seal('pw') },
    imap: null, health: { state: 'connected', checkedAt: Date.now(), message: 'ok' }, verifiedAt: Date.now(), createdAt: Date.now()
  }, 'default', 'main');

  const created = await engine.createCampaign({
    name: 'LongGap', rows: ['a@x.test', 'b@x.test', 'c@x.test'].map((e) => ({ Email: e, First: 'X' })), columns: ['Email', 'First'], emailField: 'Email',
    subject: 'hi', body: 'Hello', isHtml: false, accountId: 'main',
    pacing: { minDelayMs: 120000, maxDelayMs: 120000, randomize: false, hourlyCap: 100, dailyCap: 500 },
    sender: { email: 'w@firm.test', name: 'W', provider: 'Custom', domain: 'firm.test' }
  });
  const meta = await engine.getMeta(created.id);
  meta.status = 'running'; meta.nextSendAt = Date.now(); await engine.setMeta(meta);

  console.log('\nA 120 second gap inside a 45 second cycle');
  const t0 = Date.now();
  const result = await worker.runTick(created.id);
  const took = Date.now() - t0;
  console.log('  (the cycle stayed alive for ' + (took / 1000).toFixed(1) + 's)');

  const after = await engine.getMeta(created.id);
  check('the first message was sent', sink.received.length === 1 && after.stats.sent === 1, 'sent ' + after.stats.sent);
  check('the cycle sat out most of its time instead of handing off at once', took > 30000, took + 'ms');
  check('and still ended inside the platform limit', took < 56000, took + 'ms');
  check('it stopped because it was waiting, and is still running', result.stopReason === 'waiting' && result.status === 'running', JSON.stringify(result));
  check('it did not send early', sink.received.length === 1);
  check('the next send time was left alone', after.nextSendAt > Date.now() + 30000, String(after.nextSendAt - Date.now()));
  check('it recorded that it was alive during the wait (a sweep will not call it stalled)', Date.now() - after.worker.lastTickAt < 15000, String(Date.now() - after.worker.lastTickAt));

  console.log('\n' + passed + ' checks passed');
  process.exit(process.exitCode || 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
