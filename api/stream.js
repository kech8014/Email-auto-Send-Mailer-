'use strict';

const http = require('./_http');
const engine = require('./_engine');
const view = require('./_view');
const worker = require('./_worker');

/**
 * Server-Sent Events feed for the live monitor.
 *
 * The client subscribes once and receives campaign state pushes until the
 * function reaches its time budget, then reconnects automatically (EventSource
 * does this for us). Each frame carries the full authoritative state, so a
 * reconnect or a page reload can never leave the UI showing stale progress.
 */

const FRAME_INTERVAL_MS = 1500;
const STREAM_BUDGET_MS = 50000;

module.exports = async (req, res) => {
  if (!http.sessionFrom(req)) {
    return http.json(res, 401, { error: 'Session expired or missing', code: 'unauthenticated' });
  }

  const url = new URL(req.url, 'http://localhost');
  const id = url.searchParams.get('id');
  if (!id) return http.json(res, 400, { error: 'Campaign id required' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  const send = (event, data) => {
    if (res.writableEnded) return;
    res.write('event: ' + event + '\n');
    res.write('data: ' + JSON.stringify(data) + '\n\n');
  };

  let closed = false;
  req.on('close', () => { closed = true; });

  const startedAt = Date.now();
  let lastSignature = '';
  let revivalChecked = false;

  send('open', { ok: true, at: startedAt });

  while (!closed && Date.now() - startedAt < STREAM_BUDGET_MS) {
    let meta;
    try {
      meta = await engine.getMeta(id);
    } catch (err) {
      send('error', { message: 'State read failed' });
      break;
    }

    if (!meta) {
      send('error', { message: 'Campaign not found' });
      break;
    }

    const metrics = view.liveMetrics(meta);
    const payload = { campaign: view.publicMeta(meta), metrics };

    // Only push when something actually changed, plus a heartbeat so the
    // countdown stays live and proxies do not drop the connection.
    const signature = JSON.stringify([
      meta.status, meta.stats, meta.cursor, meta.nextSendAt,
      meta.events && meta.events[0] ? meta.events[0].t : 0
    ]);
    if (signature !== lastSignature) {
      lastSignature = signature;
      send('state', payload);
    } else {
      send('tick', { at: Date.now(), nextSendAt: meta.nextSendAt, metrics });
    }

    // If the campaign says it is running but the worker chain has gone quiet,
    // revive it. This is what makes the system self-healing after a crash.
    if (!revivalChecked && meta.status === 'running') {
      revivalChecked = true;
      const last = (meta.worker && meta.worker.lastTickAt) || meta.startedAt || 0;
      const overdue = meta.nextSendAt && meta.nextSendAt < Date.now() - 30000;
      if (Date.now() - last > 120000 || overdue) {
        worker.chain(id).catch(() => {});
        send('notice', { message: 'Worker chain revived' });
      }
    }

    if (meta.status === 'completed' || meta.status === 'stopped') {
      send('final', payload);
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, FRAME_INTERVAL_MS));
  }

  if (!res.writableEnded) {
    send('bye', { reconnect: true });
    res.end();
  }
};
