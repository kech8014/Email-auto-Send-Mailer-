'use strict';

/**
 * Slow-IMAP test.
 *
 * Run with:  node scripts/slowimap.js
 *
 * Filing a copy in the Sent folder goes over IMAP. If the IMAP server is slow or
 * hangs, that must never delay a send or stop the campaign's chain of work from
 * continuing. This points a mailbox at an IMAP server that accepts the connection
 * and then says nothing at all, and checks the worker still delivers the message,
 * finishes its cycle promptly, and hands off to the next one.
 */

process.env.SECRET_KEY = 'slowimap-test-key';
process.env.ACCESS_CODE = 'owner-code';
// Nothing to chain to when running locally: the hand-off is observed through the result.
delete process.env.PUBLIC_BASE_URL;

const net = require('net');
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
  const smtpPort = await sink.listen(0);

  // An IMAP "server" that accepts connections and never speaks.
  const hung = net.createServer(() => { /* say nothing, forever */ });
  await new Promise((r) => hung.listen(0, '127.0.0.1', r));
  const imapPort = hung.address().port;

  await engine.setConnection({
    email: 'slow@firm.test', fromName: 'Slow', domain: 'firm.test',
    provider: { id: 'custom', label: 'Custom SMTP', source: 'manual' }, dailyLimit: 500,
    smtp: { host: '127.0.0.1', port: smtpPort, secure: false, user: 'slow@firm.test', pass: secrets.seal('pw') },
    imap: { host: '127.0.0.1', port: imapPort, secure: false, user: 'slow@firm.test' },
    health: { state: 'connected', checkedAt: Date.now(), message: 'ok' }, verifiedAt: Date.now(), createdAt: Date.now()
  }, 'default', 'main');

  const created = await engine.createCampaign({
    name: 'SlowImap', rows: Array.from({ length: 80 }, (_, i) => ({ Email: 'r' + i + '@x.test', First: 'X' })), columns: ['Email', 'First'], emailField: 'Email',
    subject: 'hi {{First}}', body: 'Hello', isHtml: false, accountId: 'main',
    pacing: { minDelayMs: 1000, maxDelayMs: 1200, randomize: false, hourlyCap: 100, dailyCap: 500 },
    sender: { email: 'slow@firm.test', name: 'Slow', provider: 'Custom', domain: 'firm.test' }
  });
  const meta = await engine.getMeta(created.id);
  meta.status = 'running'; meta.nextSendAt = Date.now(); await engine.setMeta(meta);

  console.log('\nA hung IMAP server');
  const t0 = Date.now();
  const result = await worker.runTick(created.id);
  const took = Date.now() - t0;
  console.log('  (one work cycle took ' + (took / 1000).toFixed(1) + 's)');

  check('the first message was delivered despite the hung IMAP server', sink.received.length >= 1, 'delivered ' + sink.received.length);
  check('the work cycle ended inside the platform limit (60s) with room to spare', took < 56000, took + 'ms');
  check('a hung IMAP server did not slow the sends down (many went out in the cycle)', result.sentThisTick >= 20, 'sent ' + result.sentThisTick);
  check('the cycle reports success and is still running', result.ok === true && result.status === 'running', JSON.stringify(result));
  const after = await engine.getMeta(created.id);
  check('the failure to file a copy is reported as a warning, not a failed send', after.events.some((e) => e.type === 'warning' && /Sent folder|Sent mail/i.test(e.message + (e.detail || ''))), JSON.stringify(after.events.slice(0, 3)));
  check('nothing was marked as failed', after.stats.failed === 0 && after.stats.sent >= 1, JSON.stringify(after.stats));
  check('the next send is scheduled, so the chain carries on', Boolean(after.nextSendAt) && after.status === 'running');

  console.log('\n' + passed + ' checks passed');
  process.exit(process.exitCode || 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
