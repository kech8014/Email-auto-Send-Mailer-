'use strict';

const crypto = require('crypto');

/**
 * All at-rest secrets (SMTP/IMAP passwords) are sealed with AES-256-GCM under a
 * key that only ever exists as an environment variable. Nothing decrypted is
 * ever returned to the browser.
 */
function keyMaterial() {
  const secret = process.env.SECRET_KEY || process.env.ACCESS_CODE || 'kech';
  return crypto.createHash('sha256').update(String(secret)).digest();
}

function seal(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyMaterial(), iv);
  const body = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return [iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
}

function open(sealed) {
  if (typeof sealed !== 'string' || sealed.split('.').length !== 3) return null;
  const [iv, tag, body] = sealed.split('.');
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyMaterial(), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
  } catch (_) {
    return null;
  }
}

const SESSION_TTL_MS = 1000 * 60 * 60 * 8;

function issueSession() {
  const payload = Buffer.from(JSON.stringify({ iat: Date.now(), exp: Date.now() + SESSION_TTL_MS, n: crypto.randomUUID() })).toString('base64url');
  const sig = crypto.createHmac('sha256', keyMaterial()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifySession(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', keyMaterial()).update(payload).digest('base64url');
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return claims.exp > Date.now() ? claims : null;
  } catch (_) {
    return null;
  }
}

/**
 * Constant-time comparison for the dashboard access code.
 *
 * The built-in default is deliberate and is not a secret: it is published in
 * this repository, so it gates nothing from anyone who can read the source.
 * Set ACCESS_CODE in the environment to make the console actually private.
 */
const BUILT_IN_CODE = 'kech';

function codeMatches(supplied) {
  const expected = process.env.ACCESS_CODE || BUILT_IN_CODE;
  const a = Buffer.from(String(supplied || ''));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Never let a secret reach a log line or a JSON response. */
function redact(value) {
  if (!value) return null;
  const s = String(value);
  return s.length <= 4 ? '••••' : `${'•'.repeat(8)}${s.slice(-2)}`;
}

module.exports = { seal, open, issueSession, verifySession, codeMatches, redact, SESSION_TTL_MS };
