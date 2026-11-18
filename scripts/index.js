'use strict';

/**
 * Campaign list integrity test.
 *
 * Run with:  node scripts/index.js
 *
 * A campaign must never disappear from the list. This creates many campaigns at
 * the same instant (the situation that used to lose entries), then knocks some
 * out of the list on purpose and checks they are found and restored - into the
 * right person's workspace.
 */

process.env.SECRET_KEY = 'index-test-key';
process.env.ACCESS_CODE = 'owner-code';

const store = require('../api/_store');
const secrets = require('../api/_crypto');
const engine = require('../api/_engine');
const users = require('../api/_users');
const campaignApi = require('../api/campaign');

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
    statusCode: 200, writableEnded: false, setHeader() {},
    end(text) { this.writableEnded = true; out.status = this.statusCode; try { out.json = JSON.parse(text); } catch (_) { out.json = text; } }
  };
  await handler(req, res);
  return out;
}

const mk = (name, ws) => engine.createCampaign({
  ws, name, rows: [{ Email: 'a@b.test', First: 'A' }], columns: ['Email', 'First'], emailField: 'Email', subject: 's', body: 'b', isHtml: false,
  sender: { email: 'x@y.test', name: 'x', provider: 'c', domain: 'y.test' }
});

async function main() {
  const owner = { ws: 'default', name: 'Owner', admin: true };

  console.log('\nCreating many campaigns at the same instant');
  const person = await users.addUser('Pat Quinn');
  const patWs = person.user.id;
  const burst = await Promise.all([
    ...Array.from({ length: 25 }, (_, i) => mk('Owner' + i, 'default')),
    ...Array.from({ length: 25 }, (_, i) => mk('Pat' + i, patWs))
  ]);
  const ownerIds = await store.listCampaignIds('default');
  const patIds = await store.listCampaignIds(patWs);
  check('all 25 of the owner\'s campaigns are listed', burst.slice(0, 25).every((m) => ownerIds.includes(m.id)), ownerIds.length + ' listed');
  check('all 25 of the other person\'s campaigns are listed', burst.slice(25).every((m) => patIds.includes(m.id)), patIds.length + ' listed');
  check('nobody\'s campaign landed in the other\'s list', ownerIds.length === 25 && patIds.length === 25, ownerIds.length + '/' + patIds.length);

  console.log('\nOne person creating while another deletes');
  const keep = await Promise.all(Array.from({ length: 12 }, (_, i) => mk('Keep' + i, 'default')));
  const doomed = await Promise.all(Array.from({ length: 12 }, (_, i) => mk('Doomed' + i, 'default')));
  await Promise.all([
    ...doomed.map((m) => call(campaignApi, owner, { action: 'delete', id: m.id })),
    ...Array.from({ length: 12 }, (_, i) => mk('Late' + i, 'default'))
  ]);
  const afterMix = await store.listCampaignIds('default');
  check('every campaign that was kept is still listed', keep.every((m) => afterMix.includes(m.id)));
  check('every deleted campaign is gone', doomed.every((m) => !afterMix.includes(m.id)));

  console.log('\nThe list is not capped');
  const big = Array.from({ length: 640 }, (_, i) => 'cmp_fake' + i);
  await store.set('campaigns/index', big);
  await store.indexCampaign('cmp_newest', 'default');
  const grown = await store.listCampaignIds('default');
  check('more than 500 entries are all kept', grown.length === 641 && grown[0] === 'cmp_newest' && grown.includes('cmp_fake639'), String(grown.length));
  await store.set('campaigns/index', afterMix);

  console.log('\nFinding campaigns that fell out of the list');
  const lostOwner = await mk('LostOwnerCampaign', 'default');
  const lostPat = await mk('LostPatCampaign', patWs);
  // Knock both out of their lists, the way a lost write would.
  await store.set('campaigns/index', (await store.listCampaignIds('default')).filter((x) => x !== lostOwner.id));
  await store.set('ws/' + patWs + '/campaigns/index', (await store.listCampaignIds(patWs)).filter((x) => x !== lostPat.id));
  check('both are now invisible', !(await store.listCampaignIds('default')).includes(lostOwner.id) && !(await store.listCampaignIds(patWs)).includes(lostPat.id));
  const hiddenFromScreen = await call(campaignApi, owner, { action: 'list' });
  check('and they do not show on the owner\'s Campaigns page', !hiddenFromScreen.json.campaigns.some((c) => c.name === 'LostOwnerCampaign'));

  const dry = await call(campaignApi, owner, { action: 'recover', dryRun: true });
  const names = dry.json.found.map((c) => c.name).sort();
  check('a dry run finds exactly the two lost campaigns', JSON.stringify(names) === JSON.stringify(['LostOwnerCampaign', 'LostPatCampaign']), JSON.stringify(names));
  check('a dry run changes nothing', dry.json.restored === 0 && !(await store.listCampaignIds('default')).includes(lostOwner.id));
  check('it says where each one belongs', dry.json.found.find((c) => c.name === 'LostPatCampaign').ws === patWs);

  const patOnly = await call(campaignApi, { ws: patWs, name: 'Pat Quinn', admin: false }, { action: 'recover', dryRun: true });
  check('the other person can only see their own lost campaign', patOnly.json.found.length === 1 && patOnly.json.found[0].name === 'LostPatCampaign', JSON.stringify(patOnly.json.found.map((c) => c.name)));

  const fix = await call(campaignApi, owner, { action: 'recover', dryRun: false });
  check('recovery restores both', fix.json.restored === 2, JSON.stringify(fix.json.restored));
  const nowOwner = await call(campaignApi, owner, { action: 'list' });
  const nowPat = await call(campaignApi, { ws: patWs, name: 'Pat Quinn', admin: false }, { action: 'list' });
  check('the owner\'s campaign is back on the owner\'s page', nowOwner.json.campaigns.some((c) => c.name === 'LostOwnerCampaign'));
  check('the other person\'s is back on theirs - and not on the owner\'s', nowPat.json.campaigns.some((c) => c.name === 'LostPatCampaign') && !nowOwner.json.campaigns.some((c) => c.name === 'LostPatCampaign'));
  check('their data is untouched (status, name, recipients)', (await engine.getMeta(lostOwner.id)).stats.total === 1);

  const again = await call(campaignApi, owner, { action: 'recover', dryRun: false });
  check('running it again finds nothing more', again.json.found.length === 0 && again.json.restored === 0);

  console.log('\n' + passed + ' checks passed');
  process.exit(process.exitCode || 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
