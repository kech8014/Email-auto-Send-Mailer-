'use strict';

const crypto = require('crypto');
const secrets = require('./_crypto');
const store = require('./_store');

/**
 * Microsoft 365 / Outlook sign-in (OAuth 2.0 authorization-code flow).
 *
 * Microsoft is retiring basic-auth SMTP, so a mailbox password often cannot work
 * at all. Instead the user signs in on Microsoft's own page, we receive a refresh
 * token, and each worker tick trades it for a short-lived access token that is
 * presented to SMTP / IMAP with XOAUTH2. The refresh token is sealed with
 * AES-256-GCM exactly like a password; no token is ever sent to the browser.
 */

const SCOPES = [
  'openid', 'email', 'profile', 'offline_access',
  'https://outlook.office.com/SMTP.Send',
  'https://outlook.office.com/IMAP.AccessAsUser.All'
];

const STATE_TTL_MS = 10 * 60 * 1000;
const CONSUMER_DOMAINS = ['outlook.com', 'hotmail.com', 'live.com', 'msn.com'];

function config() {
  return {
    clientId: process.env.MS_CLIENT_ID || '',
    clientSecret: process.env.MS_CLIENT_SECRET || '',
    tenant: process.env.MS_TENANT || 'common'
  };
}

function isConfigured() {
  return Boolean(config().clientId);
}

function authority() {
  return 'https://login.microsoftonline.com/' + encodeURIComponent(config().tenant) + '/oauth2/v2.0';
}

/** Must match a redirect URI registered on the Azure app, character for character. */
function redirectUri(req) {
  if (process.env.MS_REDIRECT_URI) return process.env.MS_REDIRECT_URI;
  const base = process.env.PUBLIC_BASE_URL
    ? process.env.PUBLIC_BASE_URL.replace(/\/$/, '')
    : (String(req.headers['x-forwarded-proto'] || 'https').split(',')[0] + '://' + (req.headers['x-forwarded-host'] || req.headers.host));
  return base + '/api/oauth';
}

function smtpHostFor(email) {
  const domain = String(email || '').split('@')[1] || '';
  return CONSUMER_DOMAINS.includes(domain.toLowerCase())
    ? { host: 'smtp-mail.outlook.com', port: 587, secure: false }
    : { host: 'smtp.office365.com', port: 587, secure: false };
}

// The state parameter is signed and expiring, so the callback can trust it
// without a session cookie (which SameSite=Strict withholds on the way back
// from Microsoft). It also carries the display name chosen before redirecting.
function signState(payload) {
  const body = Buffer.from(JSON.stringify(Object.assign({ exp: Date.now() + STATE_TTL_MS, n: crypto.randomUUID() }, payload))).toString('base64url');
  const sig = crypto.createHmac('sha256', crypto.createHash('sha256').update('ms-state:' + (process.env.SECRET_KEY || process.env.ACCESS_CODE || 'kech')).digest()).update(body).digest('base64url');
  return body + '.' + sig;
}

function verifyState(token) {
  if (typeof token !== 'string' || token.split('.').length !== 2) return null;
  const [body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', crypto.createHash('sha256').update('ms-state:' + (process.env.SECRET_KEY || process.env.ACCESS_CODE || 'kech')).digest()).update(body).digest('base64url');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return claims.exp > Date.now() ? claims : null;
  } catch (_) {
    return null;
  }
}

function authorizeUrl(req, options) {
  const cfg = config();
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: 'code',
    redirect_uri: redirectUri(req),
    response_mode: 'query',
    scope: SCOPES.join(' '),
    prompt: 'select_account',
    state: signState({ fromName: (options && options.fromName) || '', hint: (options && options.email) || '' })
  });
  if (options && options.email) params.set('login_hint', options.email);
  return authority() + '/authorize?' + params.toString();
}

async function tokenRequest(form) {
  const cfg = config();
  const body = new URLSearchParams(Object.assign({ client_id: cfg.clientId }, form));
  if (cfg.clientSecret) body.set('client_secret', cfg.clientSecret);
  const res = await fetch(authority() + '/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    const err = new Error(data.error_description ? String(data.error_description).split(/\r?\n/)[0] : (data.error || 'Microsoft token request failed'));
    err.code = data.error || 'token_error';
    throw err;
  }
  return data;
}

function exchangeCode(req, code) {
  return tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(req),
    scope: SCOPES.join(' ')
  });
}

function refresh(refreshToken) {
  return tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken, scope: SCOPES.join(' ') });
}

/** Read the signed-in mailbox out of the id_token (received directly from Microsoft over TLS). */
function mailboxFromIdToken(idToken) {
  try {
    const claims = JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString('utf8'));
    const email = claims.email || claims.preferred_username || claims.upn || '';
    return { email: String(email).toLowerCase(), name: claims.name || null };
  } catch (_) {
    return { email: '', name: null };
  }
}

/**
 * Live credentials for a stored Microsoft connection: swap the sealed refresh
 * token for an access token and persist the rotated refresh token Microsoft
 * returns. Returns { accessToken } or { error }.
 */
async function resolveAccessToken(conn) {
  const refreshToken = secrets.open(conn.oauth && conn.oauth.refreshToken);
  if (!refreshToken) return { error: 'Stored Microsoft sign-in could not be decrypted. Reconnect the mailbox.' };
  try {
    const data = await refresh(refreshToken);
    if (data.refresh_token && data.refresh_token !== refreshToken) {
      conn.oauth.refreshToken = secrets.seal(data.refresh_token);
      await store.set('connection', conn);
    }
    return { accessToken: data.access_token };
  } catch (err) {
    const revoked = /invalid_grant|interaction_required|AADSTS/i.test(err.code + ' ' + err.message);
    return { error: (revoked ? 'Credentials rejected: Microsoft sign-in expired or was revoked. Sign in with Microsoft again. ' : '') + err.message, revoked };
  }
}

module.exports = {
  SCOPES, isConfigured, redirectUri, smtpHostFor, authorizeUrl, verifyState,
  exchangeCode, mailboxFromIdToken, resolveAccessToken
};
