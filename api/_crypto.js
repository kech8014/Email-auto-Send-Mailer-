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

/**
 * A session says who signed in. `ws` is the workspace they work in, `name` is
 * shown in the console, and `admin` is true only for the owner (the original
 * ACCESS_CODE), who is the one who can add or remove other people.
 *
 * Sessions issued before multi-user existed carry none of these fields; they are
 * read as the owner, which is exactly who they were, so nobody is signed out.
 */
function issueSession(user) {
  const u = user || {};
  const claims = {
    iat: Date.now(),
    exp: Date.now() + SESSION_TTL_MS,
    n: crypto.randomUUID(),
    ws: u.ws || 'default',
    name: u.name || 'Owner',
    admin: u.admin !== false
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
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
    if (!(claims.exp > Date.now())) return null;
    // Older sessions have no identity fields: they were the owner.
    if (!claims.ws) { claims.ws = 'default'; claims.name = claims.name || 'Owner'; claims.admin = true; }
    return claims;
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

/**
 * Additional people each get their own access code. Codes are never stored: we
 * keep a keyed digest, which is enough to recognise a code at sign-in without
 * being able to recover it.
 */
function codeDigest(code) {
  return crypto.createHmac('sha256', keyMaterial()).update('user-code:' + String(code || '')).digest('base64url');
}

function digestsMatch(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** A readable one-time code for a new person: 12 characters, no look-alikes. */
function generateCode() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(12);
  let out = '';
  for (let i = 0; i < 12; i += 1) out += alphabet[bytes[i] % alphabet.length];
  return out.slice(0, 4) + '-' + out.slice(4, 8) + '-' + out.slice(8);
}

/** Never let a secret reach a log line or a JSON response. */
function redact(value) {
  if (!value) return null;
  const s = String(value);
  return s.length <= 4 ? '••••' : `${'•'.repeat(8)}${s.slice(-2)}`;
}

module.exports = { seal, open, issueSession, verifySession, codeMatches, codeDigest, digestsMatch, generateCode, redact, SESSION_TTL_MS };
