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

async function createAction(body) {
  const conn = await engine.getConnection();
  if (!conn) return { status: 400, payload: { error: 'Connect a sending mailbox first' } };

  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (!rows.length) return { status: 400, payload: { error: 'No recipient rows supplied' } };
  if (rows.length > 20000) return { status: 400, payload: { error: 'Recipient list exceeds the 20,000 row ceiling' } };
  if (!body.emailField) return { status: 400, payload: { error: 'Select which column holds the email address' } };

  const meta = await engine.createCampaign({
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


async function controlAction(body) {
  const meta = await engine.getMeta(body.id);
  if (!meta) return { status: 404, payload: { error: 'Campaign not found' } };
  const conn = await engine.getConnection();

  switch (body.command) {
    case 'start': {
      if (meta.status === 'running') return { status: 200, payload: { campaign: publicMeta(meta), note: 'Already running' } };
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
      if (meta.status !== 'paused' && meta.status !== 'blocked') {
        return { status: 400, payload: { error: 'Campaign is not paused' } };
      }
      if (meta.status === 'blocked') {
        const recheck = conn && conn.health && conn.health.state === 'connected';
        if (!recheck) return { status: 400, payload: { error: 'Re-test the mailbox connection before resuming' } };
      }
      meta.status = 'running';
      meta.nextSendAt = Date.now();
      engine.pushEvent(meta, 'campaign', 'Campaign resumed');
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
async function analyticsAction() {
  const campaigns = await engine.listCampaigns();
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

module.exports = http.protect(async (req, res) => {
  const body = await http.readJson(req, 24 * 1024 * 1024);
  const action = body.action;
  let result;

  switch (action) {
    case 'create':
      result = await createAction(body);
      break;

    case 'list':
      result = { status: 200, payload: { campaigns: await engine.listCampaigns() } };
      break;

    case 'get': {
      const meta = await engine.getMeta(body.id);
      if (!meta) { result = { status: 404, payload: { error: 'Campaign not found' } }; break; }
      result = { status: 200, payload: { campaign: publicMeta(meta), metrics: liveMetrics(meta) } };
      break;
    }

    case 'recipients': {
      const meta = await engine.getMeta(body.id);
      if (!meta) { result = { status: 404, payload: { error: 'Campaign not found' } }; break; }
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
      if (!meta) { result = { status: 404, payload: { error: 'Campaign not found' } }; break; }
      result = { status: 200, payload: { preflight: await engine.preflight(meta, await engine.getConnection()) } };
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
      result = await controlAction(body);
      break;

    case 'analytics':
      result = await analyticsAction();
      break;

    case 'delete': {
      const meta = await engine.getMeta(body.id);
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
        await store.unindexCampaign(body.id);
      }
      result = { status: 200, payload: { ok: true, deleted: Boolean(meta), wasRunning: Boolean(meta && meta.status === 'stopped') } };
      break;
    }

    case 'suppress': {
      const list = await engine.addSuppression(body.emails || []);
      result = { status: 200, payload: { suppressed: list.length } };
      break;
    }

    default:
      result = { status: 400, payload: { error: 'Unknown action' } };
  }

  return http.json(res, result.status, result.payload);
});
