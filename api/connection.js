'use strict';

const http = require('./_http');
const store = require('./_store');
const secrets = require('./_crypto');
const engine = require('./_engine');
const users = require('./_users');
const providers = require('./_providers');

/**
 * Mailbox connection lifecycle: discover, test, save, inspect, disconnect.
 * Passwords arrive over TLS, are sealed immediately with AES-256-GCM, and are
 * only ever decrypted inside the worker. No response from this file contains a
 * credential.
 */

async function discoverAction(body) {
  const email = engine.normalizeEmail(body.email);
  if (!engine.isValidEmail(email)) {
    return { status: 400, payload: { error: 'Enter a valid email address' } };
  }
  const found = await providers.discover(email);
  return {
    status: 200,
    payload: {
      email,
      domain: found.domain,
      provider: found.provider,
      mx: found.mx,
      dailyLimit: found.dailyLimit,
      suggested: {
        smtp: found.smtp[0] || null,
        imap: found.imap[0] || null
      },
      candidates: { smtp: found.smtp.slice(0, 8), imap: found.imap.slice(0, 5) }
    }
  };
}

/**
 * Test a connection. With explicit host details we test exactly those; with
 * only an address and password we walk the discovered candidates until one
 * authenticates, which is the "just email and password" path.
 */
async function testAction(body) {
  const email = engine.normalizeEmail(body.email);
  const user = body.user || email;
  const pass = body.password;

  if (!engine.isValidEmail(email)) return { status: 400, payload: { error: 'Enter a valid email address' } };
  if (!pass) return { status: 400, payload: { error: 'A password is required to test the connection' } };

  const discovered = await providers.discover(email);
  const attempts = [];

  const smtpCandidates = body.smtp && body.smtp.host
    ? [{ host: body.smtp.host, port: Number(body.smtp.port), secure: Boolean(body.smtp.secure) }]
    : discovered.smtp.slice(0, 6);

  let smtpResult = null;
  let smtpConfig = null;
  for (const candidate of smtpCandidates) {
    const result = await providers.verifySmtp(Object.assign({}, candidate, { user, pass }));
    attempts.push({ service: 'smtp', host: candidate.host, port: candidate.port, ok: result.ok, message: result.message });
    if (result.ok) { smtpResult = result; smtpConfig = candidate; break; }
    // A rejected password will be rejected everywhere; stop probing hosts.
    if (/Credentials rejected/i.test(result.message)) { smtpResult = result; break; }
  }
  if (!smtpResult) smtpResult = { ok: false, message: 'No SMTP server responded on the addresses tried.' };

  // IMAP is optional: it confirms mailbox access but is not needed to send.
  let imapResult = null;
  let imapConfig = null;
  if (body.skipImap !== true) {
    const imapCandidates = body.imap && body.imap.host
      ? [{ host: body.imap.host, port: Number(body.imap.port), secure: body.imap.secure !== false }]
      : discovered.imap.slice(0, 3);
    for (const candidate of imapCandidates) {
      const result = await providers.verifyImap(Object.assign({}, candidate, { user, pass }));
      attempts.push({ service: 'imap', host: candidate.host, port: candidate.port, ok: result.ok, message: result.message });
      if (result.ok) { imapResult = result; imapConfig = candidate; break; }
      if (/rejected|AUTHENTICATIONFAILED/i.test(result.message)) { imapResult = result; break; }
    }
    if (!imapResult) imapResult = { ok: false, message: 'No IMAP server responded on the addresses tried.' };
  }

  return {
    status: 200,
    payload: {
      smtp: { ok: smtpResult.ok, message: smtpResult.message, config: smtpConfig },
      imap: imapResult ? { ok: imapResult.ok, message: imapResult.message, config: imapConfig } : null,
      provider: discovered.provider,
      domain: discovered.domain,
      dailyLimit: discovered.dailyLimit,
      attempts,
      canSave: smtpResult.ok
    }
  };
}

/**
 * Is this address already connected in someone else's workspace? Returns that
 * person's name, or null. It reads the live connections rather than a separate
 * registry, so there is nothing to keep in sync or migrate.
 */
async function mailboxHeldByAnother(email, ws) {
  const people = await users.listUsers();
  const nameOf = (w) => (w === 'default' ? 'the owner' : ((people.find((p) => p.id === w) || {}).name || 'another person'));
  for (const other of await users.allWorkspaces()) {
    if (other === ws) continue;
    const theirs = await engine.listConnections(other);
    if (theirs.some((m) => m.conn.email === email)) return nameOf(other);
  }
  return null;
}

/** A mailbox with its id, in the shape the browser needs. */
function view(id, conn) {
  return Object.assign({ id }, engine.publicConnection(conn));
}

async function listView(ws) {
  return (await engine.listConnections(ws)).map((m) => view(m.id, m.conn));
}

/**
 * Save a mailbox. `accountId` says which one: an existing id replaces it, "new"
 * adds another (up to the limit), and nothing means the main one. The same
 * address cannot be connected twice - two entries for one mailbox would share its
 * sending limit and defeat the point of having two.
 */
async function saveAction(body, ws) {
  const existing = await engine.listConnections(ws);
  let accountId = body.accountId || engine.MAIN_ACCOUNT;
  const email = engine.normalizeEmail(body.email);

  if (accountId === 'new') {
    if (existing.length >= engine.MAX_MAILBOXES) {
      return { status: 400, payload: { error: 'You can connect up to ' + engine.MAX_MAILBOXES + ' mailboxes. Disconnect one to add another.' } };
    }
    accountId = engine.newAccountId();
  }
  const clash = existing.find((m) => m.id !== accountId && m.conn.email === email);
  if (clash) {
    return { status: 400, payload: { error: email + ' is already connected. Each mailbox can only be connected once, so campaigns on it never share a sending limit.' } };
  }

  // Nor can two different people connect the same mailbox: they would share one
  // provider sending limit without either being able to see the other's sending,
  // which is exactly how a mailbox gets suspended.
  const holder = await mailboxHeldByAnother(email, ws);
  if (holder) {
    return { status: 400, payload: { error: email + ' is already connected by ' + holder + '. A mailbox can only be used by one person at a time - ask them to disconnect it first, or use a different mailbox.' } };
  }

  const test = await testAction(body);
  if (test.status !== 200) return test;
  if (!test.payload.smtp.ok) {
    return { status: 400, payload: { error: 'SMTP did not authenticate, so nothing was saved.', detail: test.payload } };
  }

  const user = body.user || email;
  const smtpConfig = test.payload.smtp.config;
  const imapConfig = test.payload.imap && test.payload.imap.ok ? test.payload.imap.config : null;

  const connection = {
    email,
    fromName: (body.fromName || '').trim() || null,
    domain: test.payload.domain,
    provider: test.payload.provider,
    dailyLimit: body.dailyLimit ? Number(body.dailyLimit) : test.payload.dailyLimit,
    smtp: {
      host: smtpConfig.host,
      port: smtpConfig.port,
      secure: smtpConfig.secure,
      user,
      pass: secrets.seal(body.password)
    },
    imap: imapConfig ? {
      host: imapConfig.host,
      port: imapConfig.port,
      secure: imapConfig.secure,
      user
    } : null,
    health: {
      state: 'connected',
      checkedAt: Date.now(),
      message: test.payload.imap && test.payload.imap.ok ? 'SMTP and IMAP verified' : 'SMTP verified'
    },
    verifiedAt: Date.now(),
    createdAt: Date.now()
  };

  await engine.setConnection(connection, ws, accountId);
  return { status: 200, payload: { ok: true, connection: view(accountId, connection), connections: await listView(ws) } };
}

/** Re-check a stored connection without asking for the password again. */
async function recheckAction(ws, accountId) {
  const id = accountId || engine.MAIN_ACCOUNT;
  const conn = await engine.getConnection(ws, id);
  if (!conn) return { status: 404, payload: { error: 'No mailbox connected' } };

  const credentials = engine.smtpCredentials(conn);
  if (!credentials.pass) {
    conn.health = { state: 'invalid_credentials', checkedAt: Date.now(), message: 'Stored credentials could not be decrypted. Reconnect the mailbox.' };
    await engine.setConnection(conn, ws, id);
    return { status: 200, payload: { connection: view(id, conn) } };
  }

  const result = await providers.verifySmtp(credentials);
  let state = 'connected';
  if (!result.ok) {
    if (/Credentials rejected/i.test(result.message)) state = 'invalid_credentials';
    else if (/timed out|refused|resolved/i.test(result.message)) state = 'unavailable';
    else state = 'error';
  }
  conn.health = { state, checkedAt: Date.now(), message: result.message };
  if (result.ok) conn.verifiedAt = Date.now();
  await engine.setConnection(conn, ws, id);
  return { status: 200, payload: { connection: view(id, conn) } };
}

module.exports = http.protect(async (req, res, session) => {
  const body = await http.readJson(req, 64 * 1024);
  const action = body.action;
  // Everyone works with their own mailbox only.
  const ws = (session && session.ws) || 'default';

  let result;
  switch (action) {
    case 'discover': result = await discoverAction(body); break;
    case 'test':     result = await testAction(body); break;
    case 'save':     result = await saveAction(body, ws); break;
    case 'recheck':  result = await recheckAction(ws, body.accountId); break;
    case 'list':
      result = { status: 200, payload: { connections: await listView(ws), max: engine.MAX_MAILBOXES } };
      break;
    case 'get': {
      // `connection` stays the first mailbox so older screens keep working;
      // `connections` is the full list.
      const all = await listView(ws);
      result = { status: 200, payload: { connection: all[0] || null, connections: all, max: engine.MAX_MAILBOXES } };
      break;
    }
    // The display name recipients see. Changing it is not a credential change,
    // so it must not require re-entering the password or re-testing the server.
    case 'set-name': {
      const id = body.accountId || engine.MAIN_ACCOUNT;
      const conn = await engine.getConnection(ws, id);
      if (!conn) { result = { status: 404, payload: { error: 'No mailbox connected' } }; break; }
      conn.fromName = String(body.fromName || '').trim().slice(0, 120) || null;
      await engine.setConnection(conn, ws, id);
      result = { status: 200, payload: { connection: view(id, conn) } };
      break;
    }
    case 'disconnect': {
      const id = body.accountId || engine.MAIN_ACCOUNT;
      await engine.clearConnection(ws, id);
      result = { status: 200, payload: { ok: true, connections: await listView(ws) } };
      break;
    }
    case 'providers':
      result = { status: 200, payload: { presets: providers.PRESETS.map((p) => ({ id: p.id, label: p.label, smtp: p.smtp, imap: p.imap, note: p.note || null })) } };
      break;
    default:
      result = { status: 400, payload: { error: 'Unknown action' } };
  }

  return http.json(res, result.status, result.payload);
});
