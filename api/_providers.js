'use strict';

const tls = require('tls');
const net = require('net');
const nodemailer = require('nodemailer');

/**
 * Known-good settings for the providers a marketing team is most likely to use.
 * Matched on the address domain first, then on the autodiscovered MX target so
 * a custom domain sitting on Google or Microsoft is still recognised.
 */
const PRESETS = [
  {
    id: 'google', label: 'Gmail / Google Workspace',
    domains: ['gmail.com', 'googlemail.com'], mx: [/google(mail)?\.com$/i, /googlemail\.com$/i],
    smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
    imap: { host: 'imap.gmail.com', port: 993, secure: true },
    note: 'Google requires an App Password when 2-Step Verification is on. A normal account password will be rejected.',
    dailyLimit: 500
  },
  {
    id: 'microsoft', label: 'Microsoft 365 / Outlook',
    domains: ['outlook.com', 'hotmail.com', 'live.com', 'msn.com'], mx: [/outlook\.com$/i, /protection\.outlook\.com$/i],
    smtp: { host: 'smtp-mail.outlook.com', port: 587, secure: false },
    imap: { host: 'outlook.office365.com', port: 993, secure: true },
    note: 'Microsoft 365 tenants often disable basic SMTP auth. An admin may need to enable SMTP AUTH for this mailbox.',
    dailyLimit: 10000
  },
  {
    id: 'zoho', label: 'Zoho Mail',
    domains: ['zoho.com', 'zohomail.com'], mx: [/zoho\.(com|in)$/i],
    smtp: { host: 'smtp.zoho.com', port: 465, secure: true },
    imap: { host: 'imap.zoho.com', port: 993, secure: true },
    note: 'Zoho requires an application-specific password for external clients.',
    dailyLimit: 1000
  },
  {
    id: 'zoho-eu', label: 'Zoho Mail (EU)',
    domains: ['zoho.eu'], mx: [/zoho\.eu$/i],
    smtp: { host: 'smtp.zoho.eu', port: 465, secure: true },
    imap: { host: 'imap.zoho.eu', port: 993, secure: true },
    dailyLimit: 1000
  },
  {
    id: 'yahoo', label: 'Yahoo Mail',
    domains: ['yahoo.com', 'ymail.com'], mx: [/yahoodns\.net$/i],
    smtp: { host: 'smtp.mail.yahoo.com', port: 465, secure: true },
    imap: { host: 'imap.mail.yahoo.com', port: 993, secure: true },
    note: 'Yahoo requires a generated app password.',
    dailyLimit: 500
  },
  {
    id: 'icloud', label: 'iCloud Mail',
    domains: ['icloud.com', 'me.com'], mx: [/icloud\.com$/i],
    smtp: { host: 'smtp.mail.me.com', port: 587, secure: false },
    imap: { host: 'imap.mail.me.com', port: 993, secure: true },
    note: 'iCloud requires an app-specific password.',
    dailyLimit: 500
  },
  {
    id: 'godaddy', label: 'GoDaddy Workspace',
    domains: [], mx: [/secureserver\.net$/i],
    smtp: { host: 'smtpout.secureserver.net', port: 465, secure: true },
    imap: { host: 'imap.secureserver.net', port: 993, secure: true },
    dailyLimit: 250
  },
  {
    id: 'hostinger', label: 'Hostinger',
    domains: [], mx: [/hostinger/i],
    smtp: { host: 'smtp.hostinger.com', port: 465, secure: true },
    imap: { host: 'imap.hostinger.com', port: 993, secure: true },
    dailyLimit: 3000
  },
  {
    id: 'fastmail', label: 'Fastmail',
    domains: ['fastmail.com'], mx: [/messagingengine\.com$/i],
    smtp: { host: 'smtp.fastmail.com', port: 465, secure: true },
    imap: { host: 'imap.fastmail.com', port: 993, secure: true },
    note: 'Fastmail requires an app password scoped to SMTP.',
    dailyLimit: 2000
  }
];

function presetForDomain(domain) {
  const d = String(domain || '').toLowerCase();
  return PRESETS.find((p) => p.domains.includes(d)) || null;
}

async function presetFromMx(domain) {
  try {
    const dns = require('dns').promises;
    const records = await dns.resolveMx(domain);
    const hosts = records.sort((a, b) => a.priority - b.priority).map((r) => r.exchange);
    for (const host of hosts) {
      const hit = PRESETS.find((p) => p.mx.some((re) => re.test(host)));
      if (hit) return { preset: hit, mx: hosts.slice(0, 3) };
    }
    return { preset: null, mx: hosts.slice(0, 3) };
  } catch (_) {
    return { preset: null, mx: [] };
  }
}

/** Mozilla's ISPDB covers most hosted-domain providers we have no preset for. */
async function ispdb(domain) {
  const sources = [
    'https://autoconfig.thunderbird.net/v1.1/' + domain,
    'https://autoconfig.' + domain + '/mail/config-v1.1.xml'
  ];
  for (const url of sources) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 4000);
      const res = await fetch(url, { signal: ctl.signal });
      clearTimeout(timer);
      if (!res.ok) continue;
      const xml = await res.text();
      const out = { smtp: null, imap: null, label: (xml.match(/<displayName>(.*?)<\/displayName>/) || [])[1] || null };
      const blocks = xml.match(/<(incomingServer|outgoingServer)[\s\S]*?<\/\1>/g) || [];
      for (const block of blocks) {
        const host = (block.match(/<hostname>(.*?)<\/hostname>/) || [])[1];
        const port = parseInt((block.match(/<port>(.*?)<\/port>/) || [])[1], 10);
        const socket = ((block.match(/<socketType>(.*?)<\/socketType>/) || [])[1] || '').toUpperCase();
        if (!host || !Number.isFinite(port)) continue;
        const entry = { host, port, secure: socket === 'SSL' || port === 465 || port === 993 };
        if (block.startsWith('<outgoing') && !out.smtp) out.smtp = entry;
        else if (/type="imap"/.test(block) && !out.imap) out.imap = entry;
      }
      if (out.smtp || out.imap) return out;
    } catch (_) { /* fall through to the next source */ }
  }
  return null;
}

/** Conventional host names to probe when nothing authoritative is known. */
function conventionalCandidates(domain) {
  const smtp = [];
  const imap = [];
  for (const host of ['smtp.' + domain, 'mail.' + domain, domain]) {
    smtp.push({ host, port: 465, secure: true }, { host, port: 587, secure: false });
  }
  for (const host of ['imap.' + domain, 'mail.' + domain, domain]) {
    imap.push({ host, port: 993, secure: true });
  }
  return { smtp, imap };
}

/**
 * Autodiscovery for an address: preset, then MX-derived preset, then ISPDB,
 * then conventional names. Returns ordered candidates plus what we learned.
 */
async function discover(email) {
  const parts = String(email || '').split('@');
  const domain = (parts[1] || '').toLowerCase();
  if (!domain) return { domain: '', provider: null, smtp: [], imap: [], mx: [], dailyLimit: null };

  const direct = presetForDomain(domain);
  const mxLookup = direct ? { preset: null, mx: [] } : await presetFromMx(domain);
  const preset = direct || mxLookup.preset;

  const smtp = [];
  const imap = [];
  let provider = null;

  if (preset) {
    provider = {
      id: preset.id,
      label: preset.label,
      note: preset.note || null,
      source: direct ? 'domain' : 'mx'
    };
    smtp.push(preset.smtp);
    imap.push(preset.imap);
  } else {
    const auto = await ispdb(domain);
    if (auto) {
      provider = { id: 'autoconfig', label: auto.label || domain, note: null, source: 'autoconfig' };
      if (auto.smtp) smtp.push(auto.smtp);
      if (auto.imap) imap.push(auto.imap);
    }
  }

  const conventional = conventionalCandidates(domain);
  const seenSmtp = new Set(smtp.map((c) => c.host + ':' + c.port));
  for (const c of conventional.smtp) {
    const key = c.host + ':' + c.port;
    if (!seenSmtp.has(key)) { seenSmtp.add(key); smtp.push(c); }
  }
  const seenImap = new Set(imap.map((c) => c.host + ':' + c.port));
  for (const c of conventional.imap) {
    const key = c.host + ':' + c.port;
    if (!seenImap.has(key)) { seenImap.add(key); imap.push(c); }
  }

  return {
    domain,
    provider,
    smtp,
    imap,
    mx: mxLookup.mx || [],
    dailyLimit: preset ? preset.dailyLimit || null : null
  };
}

function transportFor(config, extra) {
  return nodemailer.createTransport(Object.assign({
    host: config.host,
    port: Number(config.port),
    secure: Boolean(config.secure),
    auth: { user: config.user, pass: config.pass },
    connectionTimeout: 12000,
    greetingTimeout: 12000,
    socketTimeout: 25000,
    tls: { minVersion: 'TLSv1.2', servername: config.host }
  }, extra || {}));
}

async function verifySmtp(config) {
  const transport = transportFor(config);
  try {
    await transport.verify();
    return { ok: true, message: 'SMTP authenticated' };
  } catch (err) {
    return { ok: false, message: cleanError(err), code: (err && err.code) || null };
  } finally {
    try { transport.close(); } catch (_) {}
  }
}

/**
 * A small IMAP LOGIN probe. A full IMAP client would be far more weight than a
 * connectivity check needs.
 */
function verifyImap(config) {
  const { host, user, pass } = config;
  const port = Number(config.port);
  const secure = config.secure !== false;
  const timeout = config.timeout || 12000;

  return new Promise((resolve) => {
    let settled = false;
    let socket;
    const finish = (ok, message) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch (_) {}
      resolve({ ok, message });
    };

    try {
      socket = secure
        ? tls.connect({ host, port, servername: host, rejectUnauthorized: false })
        : net.connect({ host, port });
    } catch (err) {
      resolve({ ok: false, message: cleanError(err) });
      return;
    }

    socket.setTimeout(timeout);
    socket.on('timeout', () => finish(false, 'Connection timed out'));
    socket.on('error', (err) => finish(false, cleanError(err)));

    let buffer = '';
    let stage = 'greeting';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (stage === 'greeting' && /^\*\s+(OK|PREAUTH)/im.test(buffer)) {
        stage = 'login';
        buffer = '';
        const esc = (s) => String(s).replace(/([\\"])/g, '\\$1');
        socket.write('a1 LOGIN "' + esc(user) + '" "' + esc(pass) + '"\r\n');
        return;
      }
      if (stage === 'login') {
        if (/^a1\s+OK/im.test(buffer)) {
          try { socket.write('a2 LOGOUT\r\n'); } catch (_) {}
          finish(true, 'IMAP authenticated');
        } else if (/^a1\s+(NO|BAD)/im.test(buffer)) {
          const reason = (buffer.match(/^a1\s+(?:NO|BAD)\s+(.*)$/im) || [, 'Login rejected'])[1];
          finish(false, String(reason).trim());
        }
      }
    });
  });
}

/** Turn transport noise into something a marketer can actually act on. */
function cleanError(err) {
  const raw = String((err && err.response) || (err && err.message) || err || 'Unknown error').trim();
  if (/EAUTH|\b535\b|\b534\b|Username and Password not accepted|AUTHENTICATIONFAILED/i.test(raw)) {
    return 'Credentials rejected by the server. If the provider enforces 2FA, generate an app-specific password.';
  }
  if (/ENOTFOUND|EAI_AGAIN/i.test(raw)) return 'Server hostname could not be resolved. Check the host name.';
  if (/ECONNREFUSED/i.test(raw)) return 'Connection refused. Check the port and TLS mode.';
  if (/ETIMEDOUT|timed out|ESOCKETTIMEDOUT/i.test(raw)) return 'Connection timed out. The host or port is likely wrong, or outbound access is blocked.';
  if (/self.signed|certificate|ERR_TLS/i.test(raw)) return 'TLS certificate problem: ' + raw;
  return raw.replace(/\s+/g, ' ').slice(0, 300);
}

/**
 * Classify a send failure so the worker knows whether to retry, back off, or
 * give up. We never try to evade a provider limit - we surface it and wait.
 */
function classifyFailure(err) {
  const raw = String((err && err.response) || (err && err.message) || err || '');
  const code = (err && err.responseCode) || 0;

  if (/\b(421|450|451|452)\b/.test(raw) || code === 421 || code === 450 || code === 451 || code === 452) {
    return { kind: 'temporary', reason: cleanError(err) };
  }
  if (/rate limit|too many|throttl|quota|4\.7\.0|exceeded|try again later/i.test(raw)) {
    return { kind: 'rate_limited', reason: cleanError(err) };
  }
  if (/\b(550|551|553|554|501|502)\b/.test(raw) || code >= 500) {
    return { kind: 'permanent', reason: cleanError(err) };
  }
  if (/EAUTH|AUTHENTICATIONFAILED|\b535\b/i.test(raw)) {
    return { kind: 'auth', reason: cleanError(err) };
  }
  if (/ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket/i.test(raw)) {
    return { kind: 'temporary', reason: cleanError(err) };
  }
  return { kind: 'temporary', reason: cleanError(err) };
}

module.exports = {
  PRESETS,
  discover,
  verifySmtp,
  verifyImap,
  transportFor,
  cleanError,
  classifyFailure,
  presetForDomain
};
