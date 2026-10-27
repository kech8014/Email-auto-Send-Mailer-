'use strict';

const http = require('./_http');
const store = require('./_store');
const secrets = require('./_crypto');
const engine = require('./_engine');
const microsoft = require('./_microsoft');

/**
 * Microsoft redirects the browser here after sign-in. This is a top-level
 * cross-site navigation, so the SameSite=Strict session cookie is not sent; the
 * request is authenticated by the signed, expiring `state` issued by
 * connection.js (`oauth-start`) instead.
 */

function back(res, status, message) {
  const query = status === 'ok' ? 'ms=connected' : 'ms=error&msg=' + encodeURIComponent(String(message || 'Sign-in failed').slice(0, 300));
  res.statusCode = 302;
  res.setHeader('Location', '/?' + query + '#connection');
  res.end();
}

module.exports = http.protect(async (req, res) => {
  const params = new URL(req.url, 'http://localhost').searchParams;

  if (params.get('error')) {
    return back(res, 'error', params.get('error_description') || params.get('error'));
  }

  const state = microsoft.verifyState(params.get('state'));
  if (!state) return back(res, 'error', 'Sign-in link expired. Start again from the Connection page.');
  if (!params.get('code')) return back(res, 'error', 'Microsoft did not return an authorization code.');
  if (!microsoft.isConfigured()) return back(res, 'error', 'Microsoft sign-in is not configured on the server.');

  let tokens;
  try {
    tokens = await microsoft.exchangeCode(req, params.get('code'));
  } catch (err) {
    return back(res, 'error', err.message);
  }
  if (!tokens.refresh_token) return back(res, 'error', 'Microsoft did not grant offline access. Try again and accept every permission.');

  const mailbox = microsoft.mailboxFromIdToken(tokens.id_token);
  if (!engine.isValidEmail(mailbox.email)) return back(res, 'error', 'Could not read the mailbox address from the Microsoft account.');

  const smtp = microsoft.smtpHostFor(mailbox.email);
  const connection = {
    email: mailbox.email,
    fromName: String(state.fromName || '').trim().slice(0, 120) || null,
    domain: mailbox.email.split('@')[1],
    provider: { id: 'microsoft', label: 'Microsoft 365 / Outlook', note: null, source: 'oauth' },
    authType: 'microsoft-oauth',
    dailyLimit: 10000,
    smtp: { host: smtp.host, port: smtp.port, secure: smtp.secure, user: mailbox.email, pass: null },
    imap: { host: 'outlook.office365.com', port: 993, secure: true, user: mailbox.email },
    oauth: { refreshToken: secrets.seal(tokens.refresh_token) },
    health: { state: 'connected', checkedAt: Date.now(), message: 'Signed in with Microsoft' },
    verifiedAt: Date.now(),
    createdAt: Date.now()
  };

  await store.set('connection', connection);
  return back(res, 'ok');
}, { public: true, methods: ['GET'] });
