'use strict';

const engine = require('./_engine');

/** Serialisable campaign shape for the client. Never includes credentials. */
function publicMeta(meta) {
  if (!meta) return null;
  return {
    id: meta.id,
    name: meta.name,
    status: meta.status,
    createdAt: meta.createdAt,
    startedAt: meta.startedAt,
    completedAt: meta.completedAt,
    subject: meta.subject,
    body: meta.body,
    isHtml: meta.isHtml,
    columns: meta.columns,
    emailField: meta.emailField,
    attachments: (meta.attachments || []).map((a) => ({ name: a.name, size: a.size, type: a.type })),
    pacing: meta.pacing,
    retry: meta.retry,
    sender: meta.sender,
    cursor: meta.cursor,
    nextSendAt: meta.nextSendAt,
    stats: meta.stats,
    import: meta.import,
    events: meta.events || [],
    worker: meta.worker,
    estimate: engine.estimateDuration(meta)
  };
}

/** Derived metrics the dashboard renders as its headline numbers. */
function liveMetrics(meta) {
  if (!meta) return null;
  const now = Date.now();
  const settled = meta.stats.sent + meta.stats.failed + meta.stats.skipped;
  const percent = meta.stats.total ? (settled / meta.stats.total) * 100 : 0;
  const elapsedMs = meta.startedAt ? (meta.completedAt || now) - meta.startedAt : 0;

  const recent = (meta.sendLog || []).filter((t) => now - t < 3600000);
  const avgIntervalMs = recent.length > 1
    ? (Math.max(...recent) - Math.min(...recent)) / (recent.length - 1)
    : null;

  return {
    percent: Math.round(percent * 10) / 10,
    settled,
    remaining: meta.stats.total - settled,
    elapsedMs,
    // Derived from the observed gap, not the count of sends so far: a campaign
    // two minutes old has sent a handful of messages, and reporting that count
    // as a per-hour rate understates it by an order of magnitude. Pauses from a
    // cap or a backoff are already reflected in the measured interval.
    ratePerHour: avgIntervalMs ? Math.round(3600000 / avgIntervalMs) : 0,
    avgIntervalMs,
    etaMs: meta.status === 'running' ? engine.estimateDuration(meta).ms : null,
    nextSendAt: meta.nextSendAt,
    nextSendInMs: meta.nextSendAt ? Math.max(0, meta.nextSendAt - now) : null,
    caps: engine.capStatus(meta, now)
  };
}

module.exports = { publicMeta, liveMetrics };
