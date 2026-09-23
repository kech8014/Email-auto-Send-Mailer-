'use strict';

const crypto = require('crypto');
const store = require('./_store');
const engine = require('./_engine');
const providers = require('./_providers');
const sent = require('./_sent');
const secrets = require('./_crypto');

/**
 * The background worker.
 *
 * One invocation acquires the campaign lock, drains work until it nears the
 * platform time limit, persists after every single send, then hands off to a
 * fresh invocation of itself. Because progress is written per-send and the next
 * pending row is chosen from persisted state, a crash or timeout at any point
 * resumes exactly where it stopped and can never re-send a delivered message.
 */

const SELF_CALL_PATH = '/api/tick';

function baseUrl() {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return 'https://' + process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (process.env.VERCEL_URL) return 'https://' + process.env.VERCEL_URL;
  return null;
}

/** Internal auth for worker-to-worker calls; never the user's access code. */
function workerToken(campaignId) {
  const key = process.env.SECRET_KEY || process.env.ACCESS_CODE || 'kech';
  return crypto.createHmac('sha256', key).update('worker:' + campaignId).digest('base64url');
}

function verifyWorkerToken(campaignId, token) {
  const expected = workerToken(campaignId);
  const a = Buffer.from(String(token || ''));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Hand off to the next invocation in the chain.
 *
 * Deliberately does NOT await the response: the child runs for up to a full
 * tick budget, and waiting for it would block whoever kicked off the chain -
 * a `start` request would hang for the entire first tick. We wait only long
 * enough for the request to be dispatched, then let the promise dangle. The
 * child invocation is independent once the platform has accepted the request.
 */
async function chain(campaignId, delayHintMs) {
  const url = baseUrl();
  if (!url) return { chained: false, reason: 'No public base URL available' };

  const inFlight = fetch(url + SELF_CALL_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-worker-token': workerToken(campaignId) },
    body: JSON.stringify({ id: campaignId, hint: delayHintMs || 0 }),
    keepalive: true
  }).catch((err) => {
    console.error('[worker] chain dispatch failed for ' + campaignId + ':', err.message);
    return null;
  });

  // Give the request time to leave, but never wait for the tick to finish.
  const dispatched = await Promise.race([
    inFlight.then(() => 'responded'),
    new Promise((resolve) => setTimeout(() => resolve('dispatched'), 500))
  ]);

  return { chained: true, how: dispatched };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

/** Locate the next row that is eligible to be attempted right now. */
async function findNextEligible(meta, now) {
  const total = meta.stats.total;
  for (let index = meta.cursor; index < total; index += 1) {
    const chunkIndex = Math.floor(index / engine.CHUNK_SIZE);
    const rows = await engine.getChunk(meta.id, chunkIndex);
    for (let local = index % engine.CHUNK_SIZE; local < rows.length; local += 1) {
      const row = rows[local];
      const absolute = chunkIndex * engine.CHUNK_SIZE + local;
      if (row.status === 'queued') return { row, index: absolute };
      if (row.status === 'retrying' && (!row.nextAttemptAt || row.nextAttemptAt <= now)) {
        return { row, index: absolute };
      }
    }
    index = (chunkIndex + 1) * engine.CHUNK_SIZE - 1;
  }

  // Nothing at or after the cursor; sweep from the start for due retries.
  for (let chunkIndex = 0; chunkIndex < Math.max(1, meta.chunkCount); chunkIndex += 1) {
    const rows = await engine.getChunk(meta.id, chunkIndex);
    for (let local = 0; local < rows.length; local += 1) {
      const row = rows[local];
      if (row.status === 'retrying' && (!row.nextAttemptAt || row.nextAttemptAt <= now)) {
        return { row, index: chunkIndex * engine.CHUNK_SIZE + local };
      }
    }
  }
  return null;
}

/** Is anything still outstanding, even if not due yet? */
async function hasOutstanding(meta) {
  for (let chunkIndex = 0; chunkIndex < Math.max(1, meta.chunkCount); chunkIndex += 1) {
    const rows = await engine.getChunk(meta.id, chunkIndex);
    if (rows.some((r) => r.status === 'queued' || r.status === 'retrying')) return true;
  }
  return false;
}

function buildMessage(meta, conn, row) {
  const fields = Object.assign({}, row.fields, { email: row.email });
  const subject = engine.render(meta.subject, fields);
  const rendered = engine.render(meta.body, fields, null, { html: Boolean(meta.isHtml) });

  const html = meta.isHtml ? rendered : null;
  const text = meta.isHtml ? engine.textFromHtml(rendered) : rendered;

  const message = {
    from: conn.fromName ? '"' + conn.fromName.replace(/"/g, '') + '" <' + conn.email + '>' : conn.email,
    to: row.email,
    subject,
    text,
    headers: {}
  };
  if (html) message.html = html;

  // Standards-compliant opt-out path so recipients always have a way out.
  message.headers['List-Unsubscribe'] = '<mailto:' + conn.email + '?subject=unsubscribe>';
  message.headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';

  if (meta.attachments && meta.attachments.length) {
    message.attachments = meta.attachments.map((a) => ({
      filename: a.name,
      contentType: a.type || undefined,
      ...(a.url ? { path: a.url } : { content: Buffer.from(a.data || '', 'base64') })
    }));
  }
  return message;
}

/**
 * Drain the campaign for one invocation's worth of time.
 * Returns a summary describing why it stopped so the caller can chain or rest.
 */
async function runTick(campaignId) {
  const lockToken = await store.acquireLock(campaignId, 90000);
  if (!lockToken) return { ok: true, skipped: 'another worker holds the lock' };

  let meta = await engine.getMeta(campaignId);
  if (!meta) {
    await store.releaseLock(campaignId, lockToken);
    return { ok: false, error: 'Campaign not found' };
  }
  if (meta.status !== 'running') {
    await store.releaseLock(campaignId, lockToken);
    return { ok: true, status: meta.status, idle: true };
  }

  const conn = await engine.getConnection();
  if (!conn) {
    meta.status = 'blocked';
    engine.pushEvent(meta, 'error', 'Mailbox disconnected - campaign halted');
    await engine.setMeta(meta);
    await store.releaseLock(campaignId, lockToken);
    return { ok: false, error: 'No connection configured' };
  }

  const credentials = engine.smtpCredentials(conn);
  if (!credentials.pass) {
    meta.status = 'blocked';
    engine.pushEvent(meta, 'error', 'Stored credentials could not be decrypted. Reconnect the mailbox.');
    await engine.setMeta(meta);
    await store.releaseLock(campaignId, lockToken);
    return { ok: false, error: 'Credential decryption failed' };
  }

  // One pooled transport per invocation, reused for every send in this tick.
  const transport = providers.transportFor(credentials, {
    pool: true,
    maxConnections: 1,
    maxMessages: 50
  });

  // Same mailbox login as SMTP; opened lazily on the first successful send.
  const sentSaver = sent.createSentSaver(conn, credentials, (msg) => console.warn('[worker] ' + msg));

  const startedAt = Date.now();
  const deadline = startedAt + engine.TICK_BUDGET_MS;
  let sentThisTick = 0;
  let stopReason = 'budget';
  let warnedAboutSent = false;

  try {
    while (Date.now() < deadline) {
      meta = await engine.getMeta(campaignId);
      if (!meta || meta.status !== 'running') { stopReason = 'status:' + (meta ? meta.status : 'missing'); break; }

      const now = Date.now();

      // Respect our own rolling caps before anything else.
      const caps = engine.capStatus(meta, now);
      if (caps.blocked) {
        meta.nextSendAt = caps.resumeAt;
        engine.pushEvent(meta, 'pacing', caps.scope + ' cap reached (' + (caps.scope === 'hourly' ? caps.hourly : caps.daily) + ') - pausing until the window clears');
        await engine.setMeta(meta);
        stopReason = 'cap:' + caps.scope;
        break;
      }

      // Honour the pacing gap.
      if (meta.nextSendAt && meta.nextSendAt > now) {
        const waitMs = meta.nextSendAt - now;
        if (now + waitMs > deadline - 2000) { stopReason = 'waiting'; break; }
        await sleep(waitMs);
        continue;
      }

      const next = await findNextEligible(meta, Date.now());
      if (!next) {
        if (await hasOutstanding(meta)) {
          // Retries exist but none are due yet.
          stopReason = 'retry-wait';
          meta.nextSendAt = Date.now() + 15000;
          await engine.setMeta(meta);
        } else {
          meta.status = 'completed';
          meta.completedAt = Date.now();
          meta.nextSendAt = null;
          engine.pushEvent(meta, 'campaign', 'Campaign completed', meta.stats.sent + ' sent, ' + meta.stats.failed + ' failed');
          await engine.setMeta(meta);
          stopReason = 'completed';
        }
        break;
      }

      const { row, index } = next;
      const message = buildMessage(meta, conn, row);
      const attemptNumber = (row.attempts || 0) + 1;

      let outcome;
      let rawMessage = null;
      try {
        // Compile once and send those exact bytes, so the copy filed in Sent is
        // the message that was delivered - same Message-ID, same attachments -
        // rather than a re-render that might differ.
        const MailComposer = require('nodemailer/lib/mail-composer');
        rawMessage = await new MailComposer(message).compile().build();
        const info = await transport.sendMail({
          envelope: { from: conn.email, to: [row.email] },
          raw: rawMessage
        });
        // sendMail resolves even when the server accepted the envelope but
        // rejected this recipient, so trust the recipient list, not the promise.
        const rejected = (info.rejected || []).length;
        if (rejected) {
          outcome = { ok: false, permanent: true, reason: 'Server rejected the recipient: ' + (info.response || 'no response') };
        } else {
          outcome = { ok: true, messageId: info.messageId, response: info.response };
        }
      } catch (err) {
        outcome = { ok: false, ...providers.classifyFailure(err) };
      }

      // Re-read meta so concurrent control actions (pause/stop) are not clobbered.
      meta = await engine.getMeta(campaignId);
      if (!meta) { stopReason = 'deleted'; break; }

      const nowAfter = Date.now();

      if (outcome.ok) {
        await engine.updateRecipient(campaignId, index, {
          status: 'sent',
          attempts: attemptNumber,
          sentAt: nowAfter,
          messageId: outcome.messageId || null,
          lastError: null,
          nextAttemptAt: null
        });
        if (row.status === 'retrying') meta.stats.retrying = Math.max(0, meta.stats.retrying - 1);
        else meta.stats.queued = Math.max(0, meta.stats.queued - 1);
        meta.stats.sent += 1;
        meta.sendLog = [...(meta.sendLog || []), nowAfter].filter((t) => nowAfter - t < 86400000);
        engine.pushEvent(meta, 'sent', 'Email sent to ' + row.email, 'attempt ' + attemptNumber);
        sentThisTick += 1;

        // File a copy in the mailbox's Sent folder. The message is already
        // delivered, so this can never turn a success into a failure.
        if (sentSaver && sentSaver.enabled && rawMessage && meta.saveToSent !== false) {
          const problem = await sentSaver.save(rawMessage);
          if (problem && !warnedAboutSent) {
            warnedAboutSent = true;
            engine.pushEvent(meta, 'warning', 'Sent mail is not being copied to your Sent folder', problem);
          }
        }
      } else if (outcome.kind === 'auth') {
        // Credentials stopped working mid-campaign: stop rather than hammer.
        meta.status = 'blocked';
        engine.pushEvent(meta, 'error', 'Authentication failed - campaign paused', outcome.reason);
        await engine.setMeta(meta);
        stopReason = 'auth';
        break;
      } else if (outcome.kind === 'rate_limited') {
        // Back off and surface the provider's own message. We never work around it.
        const backoff = Math.min(1800000, (meta.retry.baseBackoffMs || 30000) * Math.pow(4, Math.min(4, attemptNumber)));
        await engine.updateRecipient(campaignId, index, {
          status: 'retrying',
          attempts: attemptNumber,
          lastError: outcome.reason,
          nextAttemptAt: nowAfter + backoff
        });
        if (row.status !== 'retrying') {
          meta.stats.queued = Math.max(0, meta.stats.queued - 1);
          meta.stats.retrying += 1;
        }
        meta.nextSendAt = nowAfter + backoff;
        engine.pushEvent(meta, 'pacing', 'Provider rate limit - backing off ' + engine.formatDuration(backoff), outcome.reason);
        await engine.setMeta(meta);
        stopReason = 'rate-limited';
        break;
      } else if (outcome.kind === 'permanent' || attemptNumber >= (meta.retry.maxAttempts || 3)) {
        await engine.updateRecipient(campaignId, index, {
          status: 'failed',
          attempts: attemptNumber,
          lastError: outcome.reason,
          nextAttemptAt: null
        });
        if (row.status === 'retrying') meta.stats.retrying = Math.max(0, meta.stats.retrying - 1);
        else meta.stats.queued = Math.max(0, meta.stats.queued - 1);
        meta.stats.failed += 1;
        engine.pushEvent(meta, 'failed', 'Permanent failure for ' + row.email, outcome.reason);
      } else {
        const backoff = (meta.retry.baseBackoffMs || 30000) * Math.pow(2, attemptNumber - 1);
        await engine.updateRecipient(campaignId, index, {
          status: 'retrying',
          attempts: attemptNumber,
          lastError: outcome.reason,
          nextAttemptAt: nowAfter + backoff
        });
        if (row.status !== 'retrying') {
          meta.stats.queued = Math.max(0, meta.stats.queued - 1);
          meta.stats.retrying += 1;
        }
        engine.pushEvent(meta, 'retry', 'Retry ' + attemptNumber + ' scheduled for ' + row.email + ' in ' + engine.formatDuration(backoff), outcome.reason);
      }

      // Advance the cursor past settled rows so scans stay cheap.
      if (index === meta.cursor) {
        let c = meta.cursor;
        const chunkIndex = Math.floor(c / engine.CHUNK_SIZE);
        const rows = await engine.getChunk(campaignId, chunkIndex);
        while (c < meta.stats.total) {
          const localRow = rows[c % engine.CHUNK_SIZE];
          if (!localRow || localRow.status === 'queued' || localRow.status === 'retrying') break;
          c += 1;
          if (Math.floor(c / engine.CHUNK_SIZE) !== chunkIndex) break;
        }
        meta.cursor = c;
      }

      meta.worker = { chainId: meta.worker ? meta.worker.chainId : null, lastTickAt: nowAfter };
      if (meta.status === 'running') meta.nextSendAt = nowAfter + engine.nextDelay(meta.pacing);
      await engine.setMeta(meta);
    }
  } finally {
    try { transport.close(); } catch (_) {}
    try { await sentSaver.close(); } catch (_) {}
    await store.releaseLock(campaignId, lockToken);
  }

  // Hand off to a fresh invocation if there is still work to do.
  const finalMeta = await engine.getMeta(campaignId);
  let chained = null;
  if (finalMeta && finalMeta.status === 'running') {
    chained = await chain(campaignId);
  }

  return {
    ok: true,
    sentThisTick,
    stopReason,
    status: finalMeta ? finalMeta.status : 'unknown',
    chained: chained ? chained.chained : false,
    elapsedMs: Date.now() - startedAt
  };
}

/** Restart any chain that died - called by cron and by the dashboard heartbeat. */
async function sweep() {
  const ids = await store.listCampaignIds();
  const revived = [];
  for (const id of ids) {
    const meta = await engine.getMeta(id);
    if (!meta || meta.status !== 'running') continue;
    const last = meta.worker && meta.worker.lastTickAt ? meta.worker.lastTickAt : meta.startedAt || 0;
    const due = meta.nextSendAt ? meta.nextSendAt : 0;
    const stalled = Date.now() - last > 120000 && (!due || due <= Date.now() + 5000);
    if (stalled) {
      revived.push(id);
      await chain(id);
    }
  }
  return { checked: ids.length, revived };
}

module.exports = { runTick, sweep, chain, workerToken, verifyWorkerToken, baseUrl, buildMessage };
