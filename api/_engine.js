'use strict';

const crypto = require('crypto');
const store = require('./_store');
const secrets = require('./_crypto');
const providers = require('./_providers');

/**
 * Campaign engine.
 *
 * State is split so the worker never rewrites a large document on every send:
 *   campaigns/<id>            small, hot metadata (cursor, stats, recent events)
 *   campaigns/<id>/r/<chunk>  recipient rows, 200 per chunk, only the touched
 *                             chunk is rewritten
 *
 * The worker is a self-chaining function: each invocation drains work until it
 * approaches the platform time limit, persists, then re-invokes itself. That is
 * what lets a campaign outlive the browser tab, a refresh, or a cold start.
 */

const CHUNK_SIZE = 200;
const MAX_EVENTS = 250;
const TICK_BUDGET_MS = 45000;

const metaKey = (id) => 'campaigns/' + id;
const chunkKey = (id, n) => 'campaigns/' + id + '/r/' + n;
const CONNECTION_KEY = 'connection';
const SETTINGS_KEY = 'settings';
const SUPPRESSION_KEY = 'suppression';

// ---------------------------------------------------------------- defaults --

/**
 * Caps are our own guard rails, sized to sit under what the provider already
 * allows - not a way around anything it enforces. 200/hour matches the weighted
 * gap distribution (mean ~22s, so ~160/hour) with headroom; 1500/day stays
 * inside Google Workspace's 2,000/day.
 *
 * Free consumer Gmail is 500/day, and a domain with no sending history should
 * be warmed up well below either. Both are editable in Settings.
 */
const DEFAULT_PACING = {
  minDelayMs: 5000,
  maxDelayMs: 120000,
  randomize: true,
  hourlyCap: 200,
  dailyCap: 1500
};

const DEFAULT_RETRY = {
  maxAttempts: 3,
  baseBackoffMs: 30000
};

// ------------------------------------------------------------- persistence --

async function getMeta(id) {
  return store.get(metaKey(id));
}

async function setMeta(meta) {
  meta.updatedAt = Date.now();
  await store.set(metaKey(meta.id), meta);
  return meta;
}

async function getChunk(id, n) {
  return (await store.get(chunkKey(id, n))) || [];
}

async function setChunk(id, n, rows) {
  await store.set(chunkKey(id, n), rows);
}

/** Read a window of recipients across chunk boundaries. */
async function readRecipients(id, offset, limit) {
  const out = [];
  let cursor = offset;
  while (out.length < limit) {
    const chunkIndex = Math.floor(cursor / CHUNK_SIZE);
    const rows = await getChunk(id, chunkIndex);
    if (!rows.length) break;
    const start = cursor % CHUNK_SIZE;
    const slice = rows.slice(start, start + (limit - out.length));
    if (!slice.length) break;
    out.push(...slice);
    cursor += slice.length;
  }
  return out;
}

async function updateRecipient(id, index, patch) {
  const chunkIndex = Math.floor(index / CHUNK_SIZE);
  const rows = await getChunk(id, chunkIndex);
  const local = index % CHUNK_SIZE;
  if (!rows[local]) return null;
  rows[local] = Object.assign({}, rows[local], patch);
  await setChunk(id, chunkIndex, rows);
  return rows[local];
}

// ------------------------------------------------------------------ events --

function pushEvent(meta, type, message, detail) {
  meta.events = meta.events || [];
  meta.events.unshift({
    t: Date.now(),
    type,
    message,
    detail: detail || null
  });
  if (meta.events.length > MAX_EVENTS) meta.events.length = MAX_EVENTS;
  return meta;
}

// -------------------------------------------------------------- connection --

async function getConnection() {
  return store.get(CONNECTION_KEY);
}

/** Public view of the connection. Secrets never leave the server. */
function publicConnection(conn) {
  if (!conn) return null;
  return {
    email: conn.email,
    fromName: conn.fromName || null,
    domain: conn.domain,
    provider: conn.provider,
    smtp: { host: conn.smtp.host, port: conn.smtp.port, secure: conn.smtp.secure, user: conn.smtp.user },
    imap: conn.imap ? { host: conn.imap.host, port: conn.imap.port, secure: conn.imap.secure, user: conn.imap.user } : null,
    password: secrets.redact('reference-only'),
    dailyLimit: conn.dailyLimit || null,
    health: conn.health || { state: 'unknown', checkedAt: null, message: null },
    verifiedAt: conn.verifiedAt || null,
    createdAt: conn.createdAt || null
  };
}

/** Rehydrate live SMTP credentials for the worker only. */
function smtpCredentials(conn) {
  return {
    host: conn.smtp.host,
    port: conn.smtp.port,
    secure: conn.smtp.secure,
    user: conn.smtp.user,
    pass: secrets.open(conn.smtp.pass)
  };
}

// --------------------------------------------------------------- settings ---

async function getSettings() {
  const saved = (await store.get(SETTINGS_KEY)) || {};
  return Object.assign({
    pacing: Object.assign({}, DEFAULT_PACING),
    retry: Object.assign({}, DEFAULT_RETRY),
    defaultSubject: '',
    defaultBody: '',
    timezone: 'UTC',
    retentionDays: 90,
    unsubscribeMailto: true
  }, saved);
}

async function saveSettings(patch) {
  const current = await getSettings();
  const next = Object.assign({}, current, patch, {
    pacing: Object.assign({}, current.pacing, patch.pacing || {}),
    retry: Object.assign({}, current.retry, patch.retry || {})
  });
  await store.set(SETTINGS_KEY, next);
  return next;
}

// ------------------------------------------------------------ suppression ---

async function getSuppression() {
  return (await store.get(SUPPRESSION_KEY)) || [];
}

async function addSuppression(emails) {
  const set = new Set((await getSuppression()).map((e) => e.toLowerCase()));
  for (const e of emails) set.add(String(e).toLowerCase());
  const list = [...set];
  await store.set(SUPPRESSION_KEY, list);
  return list;
}

// ------------------------------------------------------- recipient hygiene --

const EMAIL_RE = /^[^\s@,;<>()[\]\\]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

function normalizeEmail(raw) {
  let value = String(raw == null ? '' : raw).trim();
  // Accept "Jane Doe <jane@firm.com>" and strip stray wrappers.
  const angled = value.match(/<([^>]+)>/);
  if (angled) value = angled[1];
  value = value.replace(/^["'\s]+|["'\s.,;]+$/g, '');
  return value.toLowerCase();
}

function isValidEmail(value) {
  return EMAIL_RE.test(value) && value.length <= 254;
}

/**
 * Validate, normalise and de-duplicate imported rows, preserving every other
 * column so it can be used as a personalisation variable.
 */
function prepareRecipients(rows, emailField, suppression) {
  const suppressed = new Set((suppression || []).map((e) => e.toLowerCase()));
  const seen = new Map();
  const prepared = [];
  const issues = { invalid: [], duplicate: [], missing: 0, suppressed: [] };

  rows.forEach((row, sourceIndex) => {
    const rawEmail = row[emailField];
    const email = normalizeEmail(rawEmail);

    if (!email) {
      issues.missing += 1;
      return;
    }
    if (!isValidEmail(email)) {
      issues.invalid.push({ row: sourceIndex + 2, value: String(rawEmail).slice(0, 80) });
      return;
    }
    if (suppressed.has(email)) {
      issues.suppressed.push(email);
      return;
    }
    if (seen.has(email)) {
      issues.duplicate.push({ row: sourceIndex + 2, value: email });
      return;
    }

    seen.set(email, true);
    prepared.push({
      i: prepared.length,
      email,
      fields: row,
      status: 'queued',
      attempts: 0,
      lastError: null,
      sentAt: null,
      messageId: null,
      nextAttemptAt: null
    });
  });

  return { prepared, issues };
}

// ----------------------------------------------------------- personalising --

/**
 * Replace {{column}} tokens. Matching is case- and separator-insensitive so
 * {{first_name}}, {{First Name}} and {{firstname}} all resolve to one column.
 */
function normalizeKey(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function buildLookup(fields) {
  const lookup = new Map();
  for (const [key, value] of Object.entries(fields || {})) {
    lookup.set(normalizeKey(key), value);
  }
  return lookup;
}

/**
 * Substitute {{column}} tokens.
 *
 * `html: true` escapes each substituted value and turns its line breaks into
 * <br>. That matters whenever a whole message body arrives from a spreadsheet
 * column: the text carries real paragraph breaks that would otherwise collapse
 * into one run-on block, and an unescaped & or < in a firm name would corrupt
 * the surrounding markup. Escaping applies only to the substituted values -
 * markup written deliberately in the template is left alone.
 */
function render(template, fields, fallbacks, options) {
  if (!template) return '';
  const html = Boolean(options && options.html);
  const lookup = buildLookup(fields);
  const emit = (value) => (html ? escapeHtml(value).replace(/\r\n|\r|\n/g, '<br>') : value);

  const pass = (input) => String(input).replace(/\{\{\s*([^}|]+?)\s*(?:\|\s*([^}]*?)\s*)?\}\}/g, (match, token, fallback) => {
    const value = lookup.get(normalizeKey(token));
    if (value != null && String(value).trim() !== '') return emit(String(value).trim());
    if (fallback != null) return emit(fallback);
    if (fallbacks && fallbacks[normalizeKey(token)] != null) return emit(String(fallbacks[normalizeKey(token)]));
    return '';
  });

  // A spreadsheet cell can itself contain {{tokens}} - a subject column holding
  // "Quick note for {{first_name}}" is common when the sheet was generated from
  // another template. One pass would substitute the cell and stop, mailing the
  // raw token to the recipient. Run a second pass so those resolve too, bounded
  // at two so a self-referential value cannot loop.
  let out = pass(template);
  if (out.indexOf('{{') !== -1) out = pass(out);
  return out;
}

/** Tokens still unresolved after rendering - what the recipient would actually see. */
function leftoverTokens(rendered) {
  const found = new Set();
  const re = /\{\{\s*([^}|]+?)\s*(?:\|[^}]*)?\}\}/g;
  let m;
  while ((m = re.exec(String(rendered || '')))) found.add(m[1].trim());
  return [...found];
}

/**
 * Tokens that surface once the spreadsheet values are substituted in, but which
 * no column can fill - so they are silently dropped and the recipient reads
 * "Hello ," instead of "Hello Allan,".
 *
 * These cannot be found by inspecting the template: they live inside the data.
 * A subject column holding "Quick note for {{first_name}}" only reveals the
 * problem after the first substitution, which is what this reproduces.
 */
function pendingTokens(template, fields) {
  if (!template) return [];
  const lookup = buildLookup(fields);
  const firstPass = String(template).replace(/\{\{\s*([^}|]+?)\s*(?:\|\s*([^}]*?)\s*)?\}\}/g, (match, token, fallback) => {
    const value = lookup.get(normalizeKey(token));
    if (value != null && String(value).trim() !== '') return String(value).trim();
    return fallback != null ? fallback : '';
  });
  // Anything still token-shaped came out of the data; report the ones no column
  // and no inline fallback can satisfy.
  const re = /\{\{\s*([^}|]+?)\s*(?:\|\s*([^}]*?)\s*)?\}\}/g;
  const unfillable = new Set();
  let m;
  while ((m = re.exec(firstPass))) {
    const token = m[1].trim();
    const hasValue = lookup.get(normalizeKey(token));
    const hasFallback = m[2] != null;
    if (!hasFallback && (hasValue == null || String(hasValue).trim() === '')) unfillable.add(token);
  }
  return [...unfillable];
}

/** Which tokens a template uses, and which of them the spreadsheet can fill. */
function analyseTokens(template, columns) {
  const used = new Set();
  const re = /\{\{\s*([^}|]+?)\s*(?:\|[^}]*)?\}\}/g;
  let match;
  while ((match = re.exec(String(template || '')))) used.add(match[1].trim());
  const available = new Set((columns || []).map(normalizeKey));
  const tokens = [...used].map((token) => ({
    token,
    resolved: available.has(normalizeKey(token))
  }));
  return tokens;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function textFromHtml(html) {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h[1-6]|li)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ------------------------------------------------------------------ pacing --

/**
 * Weighted gap distribution across the pacing window.
 *
 * A uniform draw over 5s-2m produces a suspiciously even rhythm: every gap is
 * equally likely, so the mean is always ~62s and the spread is flat. Real human
 * sending is bursty - mostly quick, occasionally distracted. These buckets
 * reproduce that shape: most messages follow closely, a few pause, and a small
 * tail waits out most of the window.
 *
 * Bounds are expressed against the canonical 5s-2m window and rescaled to
 * whatever window is actually configured, so a custom min/max keeps the shape.
 */
const GAP_BUCKETS = [
  { from: 5000, to: 10000, weight: 55 },    // mostly: follows straight on
  { from: 10000, to: 30000, weight: 25 },   // some: a short pause
  { from: 30000, to: 80000, weight: 15 },   // some: a longer one
  { from: 80000, to: 120000, weight: 5 }    // rarely: near the ceiling
];
const GAP_WEIGHT_TOTAL = GAP_BUCKETS.reduce((sum, b) => sum + b.weight, 0);
const CANON_MIN = 5000;
const CANON_MAX = 120000;

function nextDelay(pacing) {
  const min = Math.max(1000, Number(pacing.minDelayMs) || DEFAULT_PACING.minDelayMs);
  const max = Math.max(min, Number(pacing.maxDelayMs) || DEFAULT_PACING.maxDelayMs);
  if (pacing.randomize === false) return min;

  let roll = Math.random() * GAP_WEIGHT_TOTAL;
  let bucket = GAP_BUCKETS[GAP_BUCKETS.length - 1];
  for (const b of GAP_BUCKETS) {
    if (roll < b.weight) { bucket = b; break; }
    roll -= b.weight;
  }

  // Map the bucket onto the configured window, then draw uniformly inside it.
  const scale = (v) => min + ((v - CANON_MIN) / (CANON_MAX - CANON_MIN)) * (max - min);
  const lo = Math.max(min, Math.min(max, scale(bucket.from)));
  const hi = Math.max(lo, Math.min(max, scale(bucket.to)));
  return Math.round(lo + Math.random() * (hi - lo));
}

/**
 * Mean gap under the weighted distribution - roughly 22s on the default window,
 * not the 62s a uniform draw would give. Estimates depend on this being right.
 */
function expectedDelay(pacing) {
  const min = Math.max(1000, Number(pacing.minDelayMs) || DEFAULT_PACING.minDelayMs);
  const max = Math.max(min, Number(pacing.maxDelayMs) || DEFAULT_PACING.maxDelayMs);
  if (pacing.randomize === false) return min;
  const canonMean = GAP_BUCKETS.reduce((sum, b) => sum + b.weight * ((b.from + b.to) / 2), 0) / GAP_WEIGHT_TOTAL;
  return min + ((canonMean - CANON_MIN) / (CANON_MAX - CANON_MIN)) * (max - min);
}

/**
 * Rolling-window caps. These are our own guard rails so a campaign stays inside
 * whatever the provider allows - not a way around anything the provider enforces.
 */
function windowUsage(log, windowMs, now) {
  return (log || []).filter((t) => now - t < windowMs).length;
}

function capStatus(meta, now) {
  const pacing = meta.pacing || DEFAULT_PACING;
  const log = meta.sendLog || [];
  const hourly = windowUsage(log, 3600000, now);
  const daily = windowUsage(log, 86400000, now);

  if (pacing.hourlyCap && hourly >= pacing.hourlyCap) {
    const oldest = log.filter((t) => now - t < 3600000).sort((a, b) => a - b)[0];
    return { blocked: true, scope: 'hourly', resumeAt: oldest + 3600000, hourly, daily };
  }
  if (pacing.dailyCap && daily >= pacing.dailyCap) {
    const oldest = log.filter((t) => now - t < 86400000).sort((a, b) => a - b)[0];
    return { blocked: true, scope: 'daily', resumeAt: oldest + 86400000, hourly, daily };
  }
  return { blocked: false, hourly, daily };
}

// ------------------------------------------------------------ campaign CRUD --

async function createCampaign(input) {
  const settings = await getSettings();
  const id = 'cmp_' + crypto.randomBytes(8).toString('hex');
  const now = Date.now();

  const suppression = await getSuppression();
  const { prepared, issues } = prepareRecipients(input.rows || [], input.emailField, suppression);

  // Write recipients out in chunks so the worker only rewrites what it touches.
  for (let n = 0; n * CHUNK_SIZE < prepared.length; n += 1) {
    await setChunk(id, n, prepared.slice(n * CHUNK_SIZE, (n + 1) * CHUNK_SIZE));
  }

  const meta = {
    id,
    name: input.name || 'Untitled campaign',
    status: 'ready',
    createdAt: now,
    startedAt: null,
    completedAt: null,
    subject: input.subject || '',
    body: input.body || '',
    isHtml: input.isHtml !== false,
    columns: input.columns || [],
    emailField: input.emailField,
    attachments: input.attachments || [],
    pacing: Object.assign({}, settings.pacing, input.pacing || {}),
    retry: Object.assign({}, settings.retry, input.retry || {}),
    sender: input.sender || null,
    cursor: 0,
    nextSendAt: null,
    sendLog: [],
    chunkCount: Math.ceil(prepared.length / CHUNK_SIZE),
    stats: {
      total: prepared.length,
      sent: 0,
      failed: 0,
      skipped: 0,
      queued: prepared.length,
      retrying: 0
    },
    import: {
      sourceRows: (input.rows || []).length,
      invalid: issues.invalid.length,
      duplicates: issues.duplicate.length,
      missing: issues.missing,
      suppressed: issues.suppressed.length,
      samples: {
        invalid: issues.invalid.slice(0, 20),
        duplicate: issues.duplicate.slice(0, 20)
      }
    },
    worker: { chainId: null, lastTickAt: null },
    events: []
  };

  pushEvent(meta, 'campaign', 'Campaign created', meta.name);
  pushEvent(meta, 'import', prepared.length + ' recipients validated from ' + ((input.rows || []).length) + ' rows');
  if (issues.invalid.length) pushEvent(meta, 'warning', issues.invalid.length + ' malformed addresses excluded');
  if (issues.duplicate.length) pushEvent(meta, 'warning', issues.duplicate.length + ' duplicate addresses removed');
  if ((input.attachments || []).length) {
    pushEvent(meta, 'attachment', (input.attachments || []).length + ' attachment(s) bound to every recipient');
  }

  await setMeta(meta);
  await store.indexCampaign(id);
  return meta;
}

async function listCampaigns() {
  const ids = await store.listCampaignIds();
  const out = [];
  for (const id of ids) {
    const meta = await getMeta(id);
    if (!meta) continue;
    out.push({
      id: meta.id,
      name: meta.name,
      status: meta.status,
      createdAt: meta.createdAt,
      startedAt: meta.startedAt,
      completedAt: meta.completedAt,
      subject: meta.subject,
      sender: meta.sender,
      stats: meta.stats,
      attachments: (meta.attachments || []).length,
      pacing: meta.pacing
    });
  }
  return out;
}

// ------------------------------------------------------------- preflight ----

async function preflight(meta, conn) {
  const checks = [];
  const add = (level, label, detail) => checks.push({ level, label, detail: detail || null });

  if (!conn) add('error', 'No mailbox connected', 'Connect a sending mailbox before starting.');
  else if (!conn.health || conn.health.state !== 'connected') {
    add('warn', 'Mailbox health not confirmed', 'Re-test the connection to be sure it can still send.');
  } else {
    add('pass', 'Mailbox connected', conn.email + ' via ' + (conn.provider ? conn.provider.label : conn.smtp.host));
  }

  if (!meta.stats.total) add('error', 'No valid recipients', 'Every imported row was rejected.');
  else add('pass', meta.stats.total + ' valid recipients', 'Ready to queue');

  if (meta.import.invalid) add('warn', meta.import.invalid + ' malformed addresses excluded', 'They will not be contacted.');
  if (meta.import.duplicates) add('warn', meta.import.duplicates + ' duplicates removed', 'Each address is contacted once.');
  if (meta.import.suppressed) add('warn', meta.import.suppressed + ' suppressed addresses skipped', 'Previously opted out.');

  if (!String(meta.subject || '').trim()) add('error', 'Subject is empty', 'A subject line is required.');
  else add('pass', 'Subject set', meta.subject.slice(0, 80));

  if (!String(meta.body || '').trim()) add('error', 'Email body is empty', 'Write the message before sending.');

  const subjectTokens = analyseTokens(meta.subject, meta.columns);
  const bodyTokens = analyseTokens(meta.body, meta.columns);
  const unresolved = [...subjectTokens, ...bodyTokens].filter((t) => !t.resolved);
  if (unresolved.length) {
    add('warn', 'Unmatched variables', unresolved.map((t) => '{{' + t.token + '}}').join(', ') + ' - these render empty unless a fallback is set.');
  } else if (subjectTokens.length + bodyTokens.length) {
    add('pass', (subjectTokens.length + bodyTokens.length) + ' personalisation variables resolved', [...new Set([...subjectTokens, ...bodyTokens].map((t) => t.token))].join(', '));
  }

  /**
   * The checks above inspect the template. That is not enough: when the subject
   * and body come from spreadsheet columns, the tokens live in the data, and a
   * sheet generated from another template can arrive with {{first_name}} still
   * unfilled. Render real rows and look at what the recipient would actually
   * receive - the only view that catches it.
   */
  const sample = await readRecipients(meta.id, 0, 25);
  const stillRaw = new Set();
  let affected = 0;
  for (const row of sample) {
    const fields = Object.assign({}, row.fields, { email: row.email });
    const leftovers = [
      ...pendingTokens(meta.subject, fields),
      ...pendingTokens(meta.body, fields),
      ...leftoverTokens(render(meta.subject, fields)),
      ...leftoverTokens(render(meta.body, fields, null, { html: Boolean(meta.isHtml) }))
    ];
    if (leftovers.length) { affected += 1; leftovers.forEach((t) => stillRaw.add(t)); }
  }
  if (stillRaw.size) {
    add('error', 'Unfilled placeholders in your content',
      [...stillRaw].map((t) => '{{' + t + '}}').join(', ') + ' appears in the text of ' + affected +
      ' of the first ' + sample.length + ' rows, and no column can fill it. Recipients would see a gap where the name should be. Add a matching column to the spreadsheet, fill the text in, or write a fallback like {{first_name|there}}.');
  } else if (sample.length) {
    add('pass', 'Rendered content is clean', 'No unfilled placeholders in the first ' + sample.length + ' rows');
  }

  const totalAttachmentBytes = (meta.attachments || []).reduce((sum, a) => sum + (a.size || 0), 0);
  if (totalAttachmentBytes > 20 * 1024 * 1024) {
    add('error', 'Attachments too large', formatBytes(totalAttachmentBytes) + ' exceeds the 20 MB ceiling most mailboxes accept.');
  } else if (totalAttachmentBytes > 8 * 1024 * 1024) {
    add('warn', 'Large attachments', formatBytes(totalAttachmentBytes) + ' may be rejected by stricter receivers.');
  } else if (meta.attachments && meta.attachments.length) {
    add('pass', meta.attachments.length + ' attachment(s), ' + formatBytes(totalAttachmentBytes), 'Sent to every recipient');
  }

  const pacing = meta.pacing || DEFAULT_PACING;
  if (conn && conn.dailyLimit && meta.stats.total > conn.dailyLimit) {
    add('warn', 'Above provider daily limit', meta.stats.total + ' recipients exceeds the ' + conn.dailyLimit + '/day this provider typically allows. The campaign will pause at the cap and resume.');
  }
  add('pass', 'Pacing policy', formatDuration(pacing.minDelayMs) + ' to ' + formatDuration(pacing.maxDelayMs) + ' between sends, ' + pacing.hourlyCap + '/hour, ' + pacing.dailyCap + '/day');

  const blocking = checks.filter((c) => c.level === 'error');
  return {
    checks,
    canStart: blocking.length === 0,
    estimate: estimateDuration(meta)
  };
}

function estimateDuration(meta) {
  const pacing = meta.pacing || DEFAULT_PACING;
  const remaining = meta.stats.total - meta.stats.sent - meta.stats.failed - meta.stats.skipped;
  const avg = expectedDelay(pacing);
  let ms = remaining * avg;

  // A cap only stretches the estimate once the list is long enough to hit it;
  // below that the pacing gap alone decides how long the campaign takes.
  if (pacing.hourlyCap && remaining > pacing.hourlyCap) {
    ms = Math.max(ms, (remaining / pacing.hourlyCap) * 3600000);
  }
  if (pacing.dailyCap && remaining > pacing.dailyCap) {
    ms = Math.max(ms, (remaining / pacing.dailyCap) * 86400000);
  }
  return { ms, remaining, avgDelayMs: avg };
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
}

function formatDuration(ms) {
  if (ms < 1000) return ms + 'ms';
  const s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return rem ? m + 'm ' + rem + 's' : m + 'm';
  const h = Math.floor(m / 60);
  return h + 'h ' + (m % 60) + 'm';
}

module.exports = {
  CHUNK_SIZE,
  TICK_BUDGET_MS,
  DEFAULT_PACING,
  DEFAULT_RETRY,
  metaKey,
  getMeta,
  setMeta,
  getChunk,
  setChunk,
  readRecipients,
  updateRecipient,
  pushEvent,
  getConnection,
  publicConnection,
  smtpCredentials,
  getSettings,
  saveSettings,
  getSuppression,
  addSuppression,
  prepareRecipients,
  normalizeEmail,
  isValidEmail,
  render,
  analyseTokens,
  pendingTokens,
  leftoverTokens,
  escapeHtml,
  textFromHtml,
  nextDelay,
  expectedDelay,
  capStatus,
  createCampaign,
  listCampaigns,
  preflight,
  estimateDuration,
  formatBytes,
  formatDuration
};
