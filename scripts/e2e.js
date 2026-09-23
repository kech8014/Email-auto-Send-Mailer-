'use strict';

/**
 * End-to-end exercise of the campaign engine against a local SMTP sink.
 *
 * Run with:  node scripts/e2e.js
 *
 * It covers the behaviour that is expensive to get wrong: real sends, merge
 * fields, attachments, duplicate and malformed rows, pacing, retry with
 * backoff, permanent-failure classification, pause/resume, and - the important
 * one - resuming after a simulated crash without re-sending anything.
 */

process.env.SECRET_KEY = 'e2e-test-key';
process.env.ACCESS_CODE = 'kech';

const assert = require('assert');
const { createSink } = require('./smtp-sink');

const store = require('../api/_store');
const secrets = require('../api/_crypto');
const engine = require('../api/_engine');
const worker = require('../api/_worker');

let passed = 0;
function check(label, condition, detail) {
  if (condition) { passed += 1; console.log('  PASS  ' + label); }
  else { console.log('  FAIL  ' + label + (detail ? '  -> ' + detail : '')); process.exitCode = 1; }
}

async function main() {
  const sink = createSink({
    failures: {
      'bounce@nowhere.test': { code: 550, text: '5.1.1 User unknown' },
      'flaky@nowhere.test': { code: 451, text: '4.3.0 Temporary local problem', transientTimes: 1 }
    }
  });
  const port = await sink.listen(0);
  console.log('\nSMTP sink listening on 127.0.0.1:' + port + '\n');

  // --- connection -----------------------------------------------------------
  await store.set('connection', {
    email: 'campaigns@firm.test',
    fromName: 'Firm Outreach',
    domain: 'firm.test',
    provider: { id: 'custom', label: 'Custom SMTP', source: 'manual' },
    dailyLimit: 500,
    smtp: { host: '127.0.0.1', port, secure: false, user: 'campaigns@firm.test', pass: secrets.seal('s3cret') },
    imap: null,
    health: { state: 'connected', checkedAt: Date.now(), message: 'SMTP verified' },
    verifiedAt: Date.now(),
    createdAt: Date.now()
  });

  console.log('Import hygiene');
  const rows = [
    { Email: 'Alice@Nowhere.test ', FirstName: 'Alice', Firm: 'Alpha LLP', City: 'Albany' },
    { Email: 'bob@nowhere.test', FirstName: 'Bob', Firm: 'Beta Law', City: 'Buffalo' },
    { Email: 'bob@nowhere.test', FirstName: 'Bob dupe', Firm: 'Beta Law', City: 'Buffalo' },
    { Email: 'not-an-email', FirstName: 'Broken', Firm: '', City: '' },
    { Email: '', FirstName: 'Empty', Firm: '', City: '' },
    { Email: '"Carol Smith" <carol@nowhere.test>', FirstName: 'Carol', Firm: 'Gamma PC', City: 'Rochester' },
    { Email: 'bounce@nowhere.test', FirstName: 'Bouncer', Firm: 'Delta', City: 'Yonkers' },
    { Email: 'flaky@nowhere.test', FirstName: 'Flaky', Firm: 'Epsilon', City: 'Syracuse' }
  ];

  const campaign = await engine.createCampaign({
    name: 'E2E outreach',
    rows,
    columns: ['Email', 'FirstName', 'Firm', 'City'],
    emailField: 'Email',
    subject: 'A note for {{first_name}} at {{firm}}',
    body: '<p>Hello {{FirstName}},</p><p>Reaching out about {{City}} matters. {{missing_field|your practice}} is the focus.</p>',
    isHtml: true,
    attachments: [{ name: 'brochure.pdf', size: 12, type: 'application/pdf', data: Buffer.from('%PDF-1.4 demo').toString('base64') }],
    pacing: { minDelayMs: 1000, maxDelayMs: 1500, randomize: true, hourlyCap: 100, dailyCap: 500 },
    retry: { maxAttempts: 3, baseBackoffMs: 1000 },
    sender: { email: 'campaigns@firm.test', name: 'Firm Outreach', provider: 'Custom SMTP', domain: 'firm.test' }
  });

  check('duplicate row removed', campaign.import.duplicates === 1, 'got ' + campaign.import.duplicates);
  check('malformed address rejected', campaign.import.invalid === 1, 'got ' + campaign.import.invalid);
  check('empty address counted as missing', campaign.import.missing === 1, 'got ' + campaign.import.missing);
  check('angle-bracket address normalised', (await engine.readRecipients(campaign.id, 0, 10)).some((r) => r.email === 'carol@nowhere.test'));
  check('uppercase address lowercased', (await engine.readRecipients(campaign.id, 0, 10)).some((r) => r.email === 'alice@nowhere.test'));
  check('5 valid recipients queued', campaign.stats.total === 5, 'got ' + campaign.stats.total);

  console.log('\nPreflight');
  const conn = await engine.getConnection();
  const pre = await engine.preflight(campaign, conn);
  check('preflight allows start', pre.canStart === true, JSON.stringify(pre.checks.filter((c) => c.level === 'error')));
  check('unmatched variable flagged', pre.checks.some((c) => /Unmatched variables/.test(c.label)));
  check('attachment reported', pre.checks.some((c) => /attachment/i.test(c.label)));
  check('duration estimated', pre.estimate.ms > 0);

  console.log('\nSending');
  let meta = await engine.getMeta(campaign.id);
  meta.status = 'running';
  meta.startedAt = Date.now();
  meta.nextSendAt = Date.now();
  await engine.setMeta(meta);

  // Drive ticks directly; chaining over HTTP is not available outside Vercel.
  const deadline = Date.now() + 90000;
  let ticks = 0;
  while (Date.now() < deadline) {
    const result = await worker.runTick(campaign.id);
    ticks += 1;
    meta = await engine.getMeta(campaign.id);
    if (meta.status !== 'running') break;
    if (result.skipped) await new Promise((r) => setTimeout(r, 200));
  }

  meta = await engine.getMeta(campaign.id);
  console.log('  ticks=' + ticks + ' status=' + meta.status + ' sent=' + meta.stats.sent + ' failed=' + meta.stats.failed);

  check('campaign completed', meta.status === 'completed', meta.status);
  check('4 messages delivered', meta.stats.sent === 4, 'sent=' + meta.stats.sent);
  check('1 permanent failure recorded', meta.stats.failed === 1, 'failed=' + meta.stats.failed);
  check('sink received 4 messages', sink.received.length === 4, 'received=' + sink.received.length);

  console.log('\nMessage content');
  const toAlice = sink.received.find((m) => m.to.includes('alice@nowhere.test'));
  check('recipient addressed individually', Boolean(toAlice));
  check('subject merge field rendered', /A note for Alice at Alpha LLP/.test(toAlice.raw), (toAlice.raw.match(/Subject:.*/) || [''])[0]);
  check('body merge field rendered', /Hello Alice/.test(decodeBody(toAlice.raw)));
  check('fallback used for missing field', /your practice is the focus/.test(decodeBody(toAlice.raw)));
  check('attachment present on every message', sink.received.every((m) => /brochure\.pdf/.test(m.raw)));
  check('plain-text alternative generated', /Content-Type: text\/plain/.test(toAlice.raw));
  check('List-Unsubscribe header set', /List-Unsubscribe:/i.test(toAlice.raw));
  check('From name applied', /From: Firm Outreach <campaigns@firm\.test>/.test(toAlice.raw), (toAlice.raw.match(/From:.*/) || [''])[0]);

  console.log('\nFailure handling');
  const all = await engine.readRecipients(campaign.id, 0, 10);
  const bouncer = all.find((r) => r.email === 'bounce@nowhere.test');
  const flaky = all.find((r) => r.email === 'flaky@nowhere.test');
  check('550 classified as permanent failure', bouncer.status === 'failed', bouncer.status);
  check('permanent failure keeps the reason', /User unknown|rejected/i.test(bouncer.lastError || ''), bouncer.lastError);
  check('451 retried then delivered', flaky.status === 'sent', flaky.status + ' attempts=' + flaky.attempts);
  check('retry counted', flaky.attempts >= 2, 'attempts=' + flaky.attempts);

  console.log('\nPacing');
  const times = sink.received.map((m) => m.at).sort((a, b) => a - b);
  const gaps = times.slice(1).map((t, i) => t - times[i]);
  check('a delay was applied between sends', gaps.every((g) => g >= 900), 'gaps=' + gaps.join(','));
  check('delays vary within the window', new Set(gaps.map((g) => Math.round(g / 100))).size > 1 || gaps.length < 2, 'gaps=' + gaps.join(','));

  console.log('\nCrash resume (no duplicate sends)');
  const before = sink.received.length;
  const resumeCampaign = await engine.createCampaign({
    name: 'Resume test',
    rows: [
      { Email: 'r1@nowhere.test', FirstName: 'R1' },
      { Email: 'r2@nowhere.test', FirstName: 'R2' },
      { Email: 'r3@nowhere.test', FirstName: 'R3' }
    ],
    columns: ['Email', 'FirstName'],
    emailField: 'Email',
    subject: 'Resume {{FirstName}}',
    body: 'Body for {{FirstName}}',
    isHtml: false,
    attachments: [],
    pacing: { minDelayMs: 1000, maxDelayMs: 1000, randomize: false, hourlyCap: 100, dailyCap: 500 },
    retry: { maxAttempts: 3, baseBackoffMs: 1000 },
    sender: { email: 'campaigns@firm.test' }
  });

  let rMeta = await engine.getMeta(resumeCampaign.id);
  rMeta.status = 'running';
  rMeta.startedAt = Date.now();
  rMeta.nextSendAt = Date.now();
  await engine.setMeta(rMeta);

  // Send one, then simulate the process dying mid-campaign.
  await worker.runTick(resumeCampaign.id);
  rMeta = await engine.getMeta(resumeCampaign.id);
  const sentBeforeCrash = rMeta.stats.sent;
  check('progress persisted mid-campaign', sentBeforeCrash >= 1, 'sent=' + sentBeforeCrash);

  // A crash leaves the lock behind; the lease must expire rather than deadlock.
  await store.set('lock/' + resumeCampaign.id, { token: 'orphan', until: Date.now() - 1000 });

  const resumeDeadline = Date.now() + 30000;
  while (Date.now() < resumeDeadline) {
    await worker.runTick(resumeCampaign.id);
    rMeta = await engine.getMeta(resumeCampaign.id);
    if (rMeta.status !== 'running') break;
  }

  const delivered = sink.received.slice(before).map((m) => m.to[0]).sort();
  check('resumed to completion', rMeta.status === 'completed', rMeta.status);
  check('exactly 3 delivered after resume', delivered.length === 3, delivered.join(','));
  check('no duplicate deliveries', new Set(delivered).size === delivered.length, delivered.join(','));
  check('orphaned lock did not deadlock the worker', rMeta.stats.sent === 3, 'sent=' + rMeta.stats.sent);

  console.log('\nControls');
  const ctlCampaign = await engine.createCampaign({
    name: 'Control test',
    rows: [{ Email: 'c1@nowhere.test' }, { Email: 'c2@nowhere.test' }],
    columns: ['Email'], emailField: 'Email',
    subject: 'Hi', body: 'Hello', isHtml: false, attachments: [],
    pacing: { minDelayMs: 60000, maxDelayMs: 60000, randomize: false, hourlyCap: 100, dailyCap: 500 },
    retry: { maxAttempts: 3, baseBackoffMs: 1000 },
    sender: { email: 'campaigns@firm.test' }
  });
  let cMeta = await engine.getMeta(ctlCampaign.id);
  cMeta.status = 'paused';
  await engine.setMeta(cMeta);
  const pausedResult = await worker.runTick(ctlCampaign.id);
  check('paused campaign does not send', pausedResult.idle === true, JSON.stringify(pausedResult));

  console.log('\nCap enforcement');
  const capMeta = await engine.getMeta(ctlCampaign.id);
  capMeta.pacing.hourlyCap = 2;
  capMeta.sendLog = [Date.now(), Date.now()];
  await engine.setMeta(capMeta);
  const caps = engine.capStatus(capMeta, Date.now());
  check('hourly cap blocks further sends', caps.blocked === true && caps.scope === 'hourly', JSON.stringify(caps));
  check('cap reports a resume time', caps.resumeAt > Date.now());

  console.log('\nSecurity');
  const stored = await store.get('connection');
  check('password sealed at rest', !/s3cret/.test(JSON.stringify(stored)), 'plaintext password found in stored connection');
  check('sealed password decrypts for the worker', secrets.open(stored.smtp.pass) === 's3cret');
  check('public view omits the password', !JSON.stringify(engine.publicConnection(stored)).includes('s3cret'));
  check('session token verifies', Boolean(secrets.verifySession(secrets.issueSession())));
  check('tampered session rejected', secrets.verifySession(secrets.issueSession().slice(0, -3) + 'aaa') === null);
  check('wrong access code rejected', secrets.codeMatches('wrong') === false);
  check('worker token is campaign-scoped', worker.verifyWorkerToken('cmp_a', worker.workerToken('cmp_b')) === false);

  await sink.close();
  console.log('\n' + passed + ' checks passed' + (process.exitCode ? ' (with failures above)' : '') + '\n');
}

function decodeBody(raw) {
  // The sink stores the raw MIME body; quoted-printable soft breaks get in the way.
  return raw.replace(/=\r?\n/g, '').replace(/=3D/g, '=');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
