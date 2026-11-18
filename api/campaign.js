'use strict';

const http = require('./_http');
const store = require('./_store');
const engine = require('./_engine');
const worker = require('./_worker');
const view = require('./_view');
const publicMeta = view.publicMeta;
const liveMetrics = view.liveMetrics;

/**
 * Campaign CRUD, preflight and lifecycle control.
 *
 * Starting a campaign only flips persisted state and kicks the worker chain -
 * the browser is never part of the sending loop, so closing the tab changes
 * nothing.
 */

/** The workspace of whoever is signed in. */
const wsOfSession = (session) => (session && session.ws) || 'default';

/**
 * A person only ever sees and controls their own campaigns. A campaign that
 * belongs to someone else is reported as not found - the same answer as one
 * that does not exist - so ids cannot be probed.
 */
function ownsCampaign(meta, session) {
  return Boolean(meta) && engine.wsOf(meta) === wsOfSession(session);
}

const NOT_FOUND = { status: 404, payload: { error: 'Campaign not found' } };

/** Refuse to run two campaigns through one mailbox: they would share its sending limit. */
async function busyError(meta) {
  const busy = await engine.mailboxBusy(meta);
  if (!busy) return null;
  const conn = (await engine.resolveAccount(meta)).conn;
  return {
    status: 409,
    payload: {
      error: (conn ? conn.email : 'This mailbox') + ' is already sending "' + busy.name + '". '
        + 'Two campaigns on one mailbox share its sending limit, which is how mailboxes get suspended. '
        + 'Send this one from your other mailbox, or start it after the other finishes.',
      busyWith: busy
    }
  };
}

async function createAction(body, session) {
  const ws = wsOfSession(session);
  // With several mailboxes connected, never guess: a silent default is how a
  // campaign ends up sent from the wrong person's mailbox.
  const mailboxes = await engine.listConnections(ws);
  if (!body.accountId && mailboxes.length > 1) {
    return { status: 400, payload: { error: 'Choose which mailbox this campaign sends from.' } };
  }
  const accountId = body.accountId || (mailboxes[0] ? mailboxes[0].id : engine.MAIN_ACCOUNT);
  const conn = await engine.getConnection(ws, accountId);
  if (!conn) return { status: 400, payload: { error: 'Connect a sending mailbox first' } };

  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (!rows.length) return { status: 400, payload: { error: 'No recipient rows supplied' } };
  if (rows.length > 20000) return { status: 400, payload: { error: 'Recipient list exceeds the 20,000 row ceiling' } };
  if (!body.emailField) return { status: 400, payload: { error: 'Select which column holds the email address' } };

  const meta = await engine.createCampaign({
    ws,
    accountId,
    ownerName: session && session.name,
    name: body.name,
    rows,
    columns: body.columns || Object.keys(rows[0] || {}),
    emailField: body.emailField,
    subject: body.subject,
    body: body.body,
    isHtml: body.isHtml,
    attachments: body.attachments || [],
    pacing: body.pacing,
    retry: body.retry,
    sender: {
      email: conn.email,
      name: conn.fromName,
      provider: conn.provider ? conn.provider.label : conn.smtp.host,
      domain: conn.domain
    }
  });

  const check = await engine.preflight(meta, conn);
  return { status: 200, payload: { campaign: publicMeta(meta), preflight: check } };
}


async function controlAction(body, session) {
  const meta = await engine.getMeta(body.id);
  if (!ownsCampaign(meta, session)) return NOT_FOUND;
  // The mailbox this campaign was created for - and only that one.
  const resolved = await engine.resolveAccount(meta);
  const conn = resolved.conn;
  const wrongMailbox = !conn && (body.command === 'start' || body.command === 'resume' || body.command === 'retry-failed')
    ? { status: 400, payload: { error: engine.accountProblem(resolved), mailbox: resolved } }
    : null;
  if (wrongMailbox) return wrongMailbox;

  switch (body.command) {
    case 'start': {
      if (meta.status === 'running') return { status: 200, payload: { campaign: publicMeta(meta), note: 'Already running' } };
      const conflict = await busyError(meta);
      if (conflict) return conflict;
      const check = await engine.preflight(meta, conn);
      if (!check.canStart) {
        return { status: 400, payload: { error: 'Preflight failed', preflight: check } };
      }
      meta.status = 'running';
      meta.startedAt = meta.startedAt || Date.now();
      meta.completedAt = null;
      meta.nextSendAt = Date.now();
      engine.pushEvent(meta, 'campaign', 'Campaign started', meta.stats.total + ' recipients queued');
      engine.pushEvent(meta, 'connection', 'Connected to SMTP', conn.smtp.host + ':' + conn.smtp.port);
      await engine.setMeta(meta);
      const kicked = await worker.chain(meta.id);
      return { status: 200, payload: { campaign: publicMeta(meta), worker: kicked } };
    }

    case 'pause': {
      if (meta.status !== 'running') return { status: 400, payload: { error: 'Campaign is not running' } };
      meta.status = 'paused';
      engine.pushEvent(meta, 'campaign', 'Campaign paused');
      await engine.setMeta(meta);
      return { status: 200, payload: { campaign: publicMeta(meta) } };
    }

    case 'resume': {
      if (meta.status !== 'paused' && meta.status !== 'blocked' && meta.status !== 'stopped') {
        return { status: 400, payload: { error: 'Campaign is not paused or stopped' } };
      }
      if (meta.status === 'blocked') {
        const recheck = conn && conn.health && conn.health.state === 'connected';
        if (!recheck) return { status: 400, payload: { error: 'Re-test the mailbox connection before resuming' } };
      }
      if (meta.status === 'stopped' && !conn) {
        return { status: 400, payload: { error: 'Connect a sending mailbox before resuming' } };
      }
      const conflict = await busyError(meta);
      if (conflict) return conflict;
      // Stop only flips the status; every row keeps its state, so the worker
      // picks up the remaining queued rows and never re-sends a sent one.
      const wasStopped = meta.status === 'stopped';
      meta.status = 'running';
      meta.completedAt = null;
      meta.nextSendAt = Date.now();
      engine.pushEvent(meta, 'campaign', wasStopped ? 'Campaign resumed after stop' : 'Campaign resumed', meta.stats.sent + ' already sent');
      await engine.setMeta(meta);
      const kicked = await worker.chain(meta.id);
      return { status: 200, payload: { campaign: publicMeta(meta), worker: kicked } };
    }

    case 'stop': {
      meta.status = 'stopped';
      meta.completedAt = Date.now();
      meta.nextSendAt = null;
      engine.pushEvent(meta, 'campaign', 'Campaign stopped by operator', meta.stats.sent + ' already sent');
      await engine.setMeta(meta);
      return { status: 200, payload: { campaign: publicMeta(meta) } };
    }

    case 'retry-failed': {
      if (meta.status !== 'running') {
        const conflict = await busyError(meta);
        if (conflict) return conflict;
      }
      let requeued = 0;
      for (let c = 0; c < Math.max(1, meta.chunkCount); c += 1) {
        const rows = await engine.getChunk(meta.id, c);
        let touched = false;
        for (const row of rows) {
          if (row.status === 'failed') {
            row.status = 'queued';
            row.attempts = 0;
            row.lastError = null;
            row.nextAttemptAt = null;
            requeued += 1;
            touched = true;
          }
        }
        if (touched) await engine.setChunk(meta.id, c, rows);
      }
      if (!requeued) return { status: 400, payload: { error: 'Nothing to retry' } };
      meta.stats.failed = Math.max(0, meta.stats.failed - requeued);
      meta.stats.queued += requeued;
      meta.cursor = 0;
      meta.status = 'running';
      meta.completedAt = null;
      meta.nextSendAt = Date.now();
      engine.pushEvent(meta, 'retry', requeued + ' failed recipients re-queued');
      await engine.setMeta(meta);
      await worker.chain(meta.id);
      return { status: 200, payload: { campaign: publicMeta(meta), requeued } };
    }

    default:
      return { status: 400, payload: { error: 'Unknown command' } };
  }
}

/** Aggregate only what we can actually observe from our own send results. */
async function analyticsAction(session) {
  const campaigns = await engine.listCampaigns(wsOfSession(session));
  const now = Date.now();
  const days = 14;
  const buckets = new Array(days).fill(0).map((_, i) => ({
    day: new Date(now - (days - 1 - i) * 86400000).toISOString().slice(0, 10),
    sent: 0,
    failed: 0
  }));

  let totals = { sent: 0, failed: 0, campaigns: campaigns.length, recipients: 0, active: 0 };
  const intervals = [];

  for (const summary of campaigns) {
    totals.sent += summary.stats.sent;
    totals.failed += summary.stats.failed;
    totals.recipients += summary.stats.total;
    if (summary.status === 'running') totals.active += 1;

    const meta = await engine.getMeta(summary.id);
    if (!meta) continue;
    for (const t of meta.sendLog || []) {
      const day = new Date(t).toISOString().slice(0, 10);
      const bucket = buckets.find((b) => b.day === day);
      if (bucket) bucket.sent += 1;
    }
    const log = (meta.sendLog || []).slice().sort((a, b) => a - b);
    for (let i = 1; i < log.length; i += 1) intervals.push(log[i] - log[i - 1]);
  }

  const avgInterval = intervals.length
    ? intervals.reduce((a, b) => a + b, 0) / intervals.length
    : null;

  return {
    status: 200,
    payload: {
      totals,
      series: buckets,
      avgIntervalMs: avgInterval,
      successRate: totals.sent + totals.failed ? (totals.sent / (totals.sent + totals.failed)) * 100 : null,
      note: 'Metrics reflect transport-level results only. Opens, clicks and deliverability are not tracked.'
    }
  };
}

module.exports = http.protect(async (req, res, session) => {
  const body = await http.readJson(req, 24 * 1024 * 1024);
  const action = body.action;
  let result;

  switch (action) {
    case 'create':
      result = await createAction(body, session);
      break;

    case 'list':
      result = { status: 200, payload: { campaigns: await engine.listCampaigns(wsOfSession(session)) } };
      break;

    case 'get': {
      const meta = await engine.getMeta(body.id);
      if (!ownsCampaign(meta, session)) { result = NOT_FOUND; break; }
      result = { status: 200, payload: { campaign: publicMeta(meta), metrics: liveMetrics(meta) } };
      break;
    }

    case 'recipients': {
      const meta = await engine.getMeta(body.id);
      if (!ownsCampaign(meta, session)) { result = NOT_FOUND; break; }
      const offset = Math.max(0, Number(body.offset) || 0);
      const limit = Math.min(500, Math.max(1, Number(body.limit) || 100));
      let rows = await engine.readRecipients(body.id, offset, limit);
      if (body.filter && body.filter !== 'all') rows = rows.filter((r) => r.status === body.filter);
      if (body.search) {
        const q = String(body.search).toLowerCase();
        rows = rows.filter((r) => r.email.includes(q) || JSON.stringify(r.fields).toLowerCase().includes(q));
      }
      result = { status: 200, payload: { recipients: rows, offset, total: meta.stats.total } };
      break;
    }

    case 'preflight': {
      const meta = await engine.getMeta(body.id);
      if (!ownsCampaign(meta, session)) { result = NOT_FOUND; break; }
      result = { status: 200, payload: { preflight: await engine.preflight(meta, (await engine.resolveAccount(meta)).conn) } };
      break;
    }

    case 'preview': {
      // Render subject and body against a real row so the operator sees exactly
      // what will be delivered.
      const fields = body.fields || {};
      result = {
        status: 200,
        payload: {
          subject: engine.render(body.subject || '', fields),
          body: engine.render(body.body || '', fields),
          tokens: [
            ...engine.analyseTokens(body.subject || '', body.columns || Object.keys(fields)),
            ...engine.analyseTokens(body.body || '', body.columns || Object.keys(fields))
          ]
        }
      };
      break;
    }

    case 'control':
      result = await controlAction(body, session);
      break;

    case 'analytics':
      result = await analyticsAction(session);
      break;

    case 'delete': {
      const found = await engine.getMeta(body.id);
      const meta = ownsCampaign(found, session) ? found : null;
      if (meta) {
        // Halt first. A tick may be asleep in its pacing gap right now; the
        // loop re-reads status before every send, so marking it stopped closes
        // the window where it wakes and sends one more after the delete.
        if (meta.status === 'running') {
          meta.status = 'stopped';
          meta.nextSendAt = null;
          engine.pushEvent(meta, 'campaign', 'Campaign stopped - deleted by operator');
          await engine.setMeta(meta);
        }
        for (let c = 0; c < Math.max(1, meta.chunkCount); c += 1) await store.del('campaigns/' + body.id + '/r/' + c);
        await store.del('campaigns/' + body.id);
        await store.unindexCampaign(body.id, engine.wsOf(meta));
      }
      result = { status: 200, payload: { ok: true, deleted: Boolean(meta), wasRunning: Boolean(meta && meta.status === 'stopped') } };
      break;
    }

    // Move a campaign that is not running to a different one of your mailboxes.
    // Messages already sent stay as they were; the rest will go from the new one.
    case 'move': {
      const found = await engine.getMeta(body.id);
      if (!ownsCampaign(found, session)) { result = NOT_FOUND; break; }
      const meta = found;
      if (meta.status === 'running') {
        result = { status: 400, payload: { error: 'Pause or stop this campaign before moving it to another mailbox.' } };
        break;
      }
      const ws = wsOfSession(session);
      const target = await engine.getConnection(ws, body.accountId);
      if (!target) { result = { status: 400, payload: { error: 'Choose one of your connected mailboxes.' } }; break; }
      const before = await engine.resolveAccount(meta);
      const fromEmail = (before.conn && before.conn.email) || (meta.sender && meta.sender.email) || 'its previous mailbox';
      if (String(fromEmail).toLowerCase() === String(target.email).toLowerCase()) {
        result = { status: 400, payload: { error: 'This campaign already sends from ' + target.email + '.' } };
        break;
      }
      meta.accountId = body.accountId;
      meta.sender = {
        email: target.email,
        name: target.fromName,
        provider: target.provider ? target.provider.label : target.smtp.host,
        domain: target.domain
      };
      // A campaign that was blocked only because its mailbox was missing can now go.
      if (meta.status === 'blocked') meta.status = 'paused';
      engine.pushEvent(meta, 'campaign', 'Moved to ' + target.email,
        'Was ' + fromEmail + '. ' + meta.stats.sent + ' already sent from the old address; the remaining ' + meta.stats.queued + ' will send from the new one.');
      await engine.setMeta(meta);
      result = { status: 200, payload: { campaign: publicMeta(meta), from: fromEmail, to: target.email } };
      break;
    }

    // Find campaigns that are saved but missing from the list, and put them back.
    // The owner covers everyone's workspaces; anyone else only their own.
    case 'recover': {
      const scan = await engine.findUnlistedCampaigns();
      const mine = (c) => wsOfSession(session) === 'default' && session.admin === true ? true : c.ws === wsOfSession(session);
      const found = scan.unlisted.filter(mine);
      const restored = body.dryRun === false ? await engine.restoreCampaigns(found) : 0;
      result = { status: 200, payload: { supported: scan.supported, scanned: scan.scanned, found, restored } };
      break;
    }

    case 'suppress': {
      const list = await engine.addSuppression(body.emails || [], wsOfSession(session));
      result = { status: 200, payload: { suppressed: list.length } };
      break;
    }

    default:
      result = { status: 400, payload: { error: 'Unknown action' } };
  }

  return http.json(res, result.status, result.payload);
});
