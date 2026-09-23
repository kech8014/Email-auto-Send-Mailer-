'use strict';

/**
 * Saving a copy to the Sent folder.
 *
 * Sending over SMTP hands the message to the outgoing server and nothing more.
 * The Sent folder is an IMAP folder, and a copy only appears there if a client
 * explicitly APPENDs it - which is why desktop clients and webmail show sent
 * mail, and a raw SMTP script does not. Without this, a campaign leaves no
 * trace in the mailbox it was sent from, which looks exactly like a tool that
 * claims to have sent and did not.
 *
 * This is best-effort by design: the message is already delivered by the time
 * we get here, so a failure to file a copy must never be reported as a failed
 * send. It is surfaced as a warning instead.
 */

const SENT_NAMES = ['Sent', 'Sent Items', 'Sent Mail', 'INBOX.Sent', '[Gmail]/Sent Mail', 'Sent Messages', 'OUTBOX'];

/**
 * One IMAP connection per worker tick, opened lazily. Opening costs a round
 * trip and a TLS handshake, so we do not pay it for a campaign that never
 * sends anything.
 */
function createSentSaver(conn, credentials, logger) {
  const enabled = Boolean(conn && conn.imap && conn.imap.host && credentials && credentials.pass);
  let client = null;
  let mailbox = null;
  let broken = false;

  async function connect() {
    const { ImapFlow } = require('imapflow');
    const c = new ImapFlow({
      host: conn.imap.host,
      port: conn.imap.port || 993,
      secure: conn.imap.secure !== false,
      auth: { user: conn.imap.user || conn.email, pass: credentials.pass },
      logger: false,
      emitLogs: false
    });
    await c.connect();

    // Prefer the folder the server itself flags as Sent; fall back to the
    // names providers actually use before giving up.
    let target = null;
    for (const box of await c.list()) {
      const flags = box.flags instanceof Set ? [...box.flags] : (box.flags || []);
      if (box.specialUse === '\\Sent' || flags.includes('\\Sent')) { target = box.path; break; }
    }
    if (!target) {
      const paths = new Set((await c.list()).map((b) => b.path));
      target = SENT_NAMES.find((n) => paths.has(n)) || null;
    }
    if (!target) throw new Error('No Sent folder found on the IMAP server');

    client = c;
    mailbox = target;
    return target;
  }

  return {
    enabled,
    get mailbox() { return mailbox; },

    /** Returns null on success, or a human-readable reason it could not file. */
    async save(raw) {
      if (!enabled || broken) return enabled ? 'previous IMAP failure' : 'no IMAP configured';
      try {
        if (!client) await connect();
        await client.append(mailbox, raw, ['\\Seen']);
        return null;
      } catch (err) {
        // One failure usually means every following one fails too; stop trying
        // rather than adding a doomed round trip to every send.
        broken = true;
        try { if (client) await client.logout(); } catch (_) {}
        client = null;
        if (logger) logger('Could not save to Sent: ' + err.message);
        return err.message;
      }
    },

    async close() {
      if (!client) return;
      try { await client.logout(); } catch (_) {}
      client = null;
    }
  };
}

module.exports = { createSentSaver, SENT_NAMES };
