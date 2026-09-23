/* =============================================================================
   Kech Mailer - console
   No credential ever lives here: the session is an HttpOnly cookie and the
   mailbox password is posted once, then only ever exists encrypted server-side.
   ========================================================================== */
(function () {
  'use strict';

  // ------------------------------------------------------------------ utils --

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value == null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'html') node.innerHTML = value;
      else if (key === 'text') node.textContent = value;
      else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
      else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
      else node.setAttribute(key, value === true ? '' : value);
    }
    for (const child of [].concat(children || [])) {
      if (child == null || child === false) continue;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return node;
  }

  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const nf = new Intl.NumberFormat('en-US');
  const fmtNum = (n) => nf.format(Math.round(Number(n) || 0));

  function fmtBytes(bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    return (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
  }

  function fmtDuration(ms, compact) {
    if (ms == null || !isFinite(ms)) return '--';
    const total = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (compact) {
      if (h) return h + 'h ' + String(m).padStart(2, '0') + 'm';
      if (m) return m + 'm ' + String(s).padStart(2, '0') + 's';
      return s + 's';
    }
    if (h) return h + 'h ' + m + 'm';
    if (m) return m + 'm ' + s + 's';
    return s + 's';
  }

  const fmtClock = (ms) => {
    const t = Math.max(0, Math.round(ms / 1000));
    return String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0');
  };

  const fmtTime = (ts) => ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '--';
  const fmtDate = (ts) => ts ? new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : '--';
  const fmtDateTime = (ts) => ts ? fmtDate(ts) + ', ' + fmtTime(ts) : '--';

  const debounce = (fn, wait) => {
    let timer;
    return function () {
      const args = arguments;
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(null, args), wait);
    };
  };

  const normKey = (key) => String(key).toLowerCase().replace(/[^a-z0-9]/g, '');

  // -------------------------------------------------------------------- api --

  async function api(endpoint, payload) {
    let res;
    try {
      res = await fetch('/api/' + endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(payload || {})
      });
    } catch (err) {
      throw new Error('Network unreachable. Check your connection.');
    }

    let data = {};
    try { data = await res.json(); } catch (_) {}

    if (res.status === 401 && data.code === 'unauthenticated') {
      showGate('Your session expired. Sign in again.');
      throw new Error('Session expired');
    }
    if (!res.ok) {
      const err = new Error(data.error || 'Request failed (' + res.status + ')');
      err.payload = data;
      throw err;
    }
    return data;
  }

  // ------------------------------------------------------------------ toast --

  function toast(message, kind, ttl) {
    const node = el('div', { class: 'toast', 'data-kind': kind || 'info' }, [
      el('span', { class: 'mark' }),
      el('div', { style: { minWidth: 0, flex: '1' }, text: message }),
      el('button', { class: 'x', 'aria-label': 'Dismiss', text: '×', onclick: () => dismiss() })
    ]);
    $('#toasts').appendChild(node);
    let timer = setTimeout(dismiss, ttl || (kind === 'err' ? 8000 : 4200));
    function dismiss() {
      clearTimeout(timer);
      node.classList.add('is-out');
      setTimeout(() => node.remove(), 220);
    }
    return dismiss;
  }

  // ------------------------------------------------------------------ modal --

  function modal(title, bodyNode, actions) {
    const backdrop = el('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target === backdrop) close(); } });
    const box = el('div', { class: 'modal' }, [
      el('h3', { class: 'h-md', style: { marginBottom: '16px' }, text: title }),
      bodyNode,
      el('div', { class: 'row', style: { justifyContent: 'flex-end', marginTop: '22px' } }, actions || [])
    ]);
    backdrop.appendChild(box);
    $('#modal-root').appendChild(backdrop);
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    function close() {
      document.removeEventListener('keydown', onKey);
      backdrop.remove();
    }
    return close;
  }

  function confirmDialog(title, message, confirmLabel) {
    return new Promise((resolve) => {
      const close = modal(title, el('p', { class: 'lede', text: message }), [
        el('button', { class: 'btn', text: 'Cancel', onclick: () => { close(); resolve(false); } }),
        el('button', { class: 'btn btn--primary', text: confirmLabel || 'Confirm', onclick: () => { close(); resolve(true); } })
      ]);
    });
  }

  // ------------------------------------------------------------------ state --

  const state = {
    route: 'dashboard',
    connection: null,
    settings: null,
    campaigns: [],
    analytics: null,
    activeCampaignId: null,
    sessionExpiresAt: null,
    campaign: null,
    metrics: null,
    stream: null,
    countdownTimer: null,
    draft: {
      name: '',
      rows: [],
      columns: [],
      emailField: '',
      subject: '',
      body: '',
      isHtml: true,
      attachments: [],
      pacing: null,
      fileName: ''
    }
  };

  // ------------------------------------------------------------ spreadsheet --

  /** Delimiter-aware CSV parser with quoted-field support. */
  function parseCsv(text) {
    const sample = text.slice(0, 5000);
    const counts = { ',': 0, ';': 0, '\t': 0, '|': 0 };
    let inQuote = false;
    for (let i = 0; i < sample.length; i += 1) {
      const c = sample[i];
      if (c === '"') inQuote = !inQuote;
      else if (!inQuote && counts[c] !== undefined) counts[c] += 1;
    }
    const delim = Object.keys(counts).reduce((a, b) => (counts[b] > counts[a] ? b : a), ',');

    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;

    for (let i = 0; i < text.length; i += 1) {
      const c = text[i];
      if (quoted) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 1; }
          else quoted = false;
        } else field += c;
        continue;
      }
      if (c === '"') { quoted = true; continue; }
      if (c === delim) { row.push(field); field = ''; continue; }
      if (c === '\r') continue;
      if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
      field += c;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows.filter((r) => r.some((cell) => String(cell).trim() !== ''));
  }

  function matrixToObjects(matrix) {
    if (!matrix.length) return { columns: [], rows: [] };

    // Skip any preamble rows above the real header.
    let headerIndex = 0;
    for (let i = 0; i < Math.min(5, matrix.length); i += 1) {
      const filled = matrix[i].filter((c) => String(c).trim() !== '').length;
      if (filled >= Math.max(2, Math.floor(matrix[i].length * 0.5))) { headerIndex = i; break; }
    }

    const rawHeader = matrix[headerIndex];
    const seen = {};
    const columns = rawHeader.map((cell, i) => {
      let name = String(cell == null ? '' : cell).trim() || ('Column ' + (i + 1));
      if (seen[name]) { seen[name] += 1; name = name + ' (' + seen[name] + ')'; }
      else seen[name] = 1;
      return name;
    });

    const rows = matrix.slice(headerIndex + 1).map((line) => {
      const obj = {};
      columns.forEach((col, i) => { obj[col] = line[i] == null ? '' : String(line[i]).trim(); });
      return obj;
    }).filter((obj) => Object.values(obj).some((v) => v !== ''));

    return { columns, rows };
  }

  const EMAIL_HINTS = ['email', 'emailaddress', 'e-mail', 'mail', 'emailid', 'contactemail', 'workemail', 'primaryemail', 'address', 'to'];
  const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  /** Pick the email column by header name first, then by what the data looks like. */
  function detectEmailColumn(columns, rows) {
    const byName = columns.find((c) => EMAIL_HINTS.includes(normKey(c)));
    if (byName) return byName;
    const partial = columns.find((c) => /mail/i.test(c));
    if (partial) return partial;

    let best = null;
    let bestScore = 0;
    const sample = rows.slice(0, 60);
    for (const col of columns) {
      const hits = sample.filter((r) => EMAIL_SHAPE.test(String(r[col] || '').trim())).length;
      const score = sample.length ? hits / sample.length : 0;
      if (score > bestScore) { bestScore = score; best = col; }
    }
    return bestScore >= 0.5 ? best : null;
  }

  const FIELD_ROLES = [
    { role: 'first_name', hints: ['firstname', 'fname', 'givenname', 'first'] },
    { role: 'last_name', hints: ['lastname', 'lname', 'surname', 'familyname', 'last'] },
    { role: 'full_name', hints: ['name', 'fullname', 'contactname', 'attorney', 'attorneyname', 'contact'] },
    { role: 'firm_name', hints: ['firm', 'firmname', 'company', 'companyname', 'organisation', 'organization', 'practice'] },
    { role: 'city', hints: ['city', 'town', 'locality'] },
    { role: 'county', hints: ['county'] },
    { role: 'state', hints: ['state', 'province', 'region'] },
    { role: 'phone', hints: ['phone', 'telephone', 'mobile', 'cell'] },
    { role: 'case_id', hints: ['caseid', 'case', 'matter', 'matterid', 'docket'] },
    { role: 'title', hints: ['title', 'role', 'position'] },
    { role: 'website', hints: ['website', 'url', 'site', 'web'] }
  ];

  /** Map spreadsheet columns onto the personalisation roles we recognise. */
  function detectRoles(columns) {
    const out = [];
    for (const { role, hints } of FIELD_ROLES) {
      const match = columns.find((c) => hints.includes(normKey(c)));
      if (match) out.push({ role, column: match });
    }
    return out;
  }

  function readSpreadsheet(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      const isCsv = /\.(csv|tsv|txt)$/i.test(file.name);

      reader.onerror = () => reject(new Error('Could not read the file'));
      reader.onload = () => {
        try {
          let matrix;
          if (isCsv) {
            // Strip a UTF-8 BOM so the first header is not corrupted.
            const text = String(reader.result).replace(/^﻿/, '');
            matrix = parseCsv(text);
          } else {
            if (typeof XLSX === 'undefined') throw new Error('Spreadsheet reader failed to load. Check your network and reload.');
            const workbook = XLSX.read(new Uint8Array(reader.result), { type: 'array', cellDates: false, raw: false });
            const sheet = workbook.Sheets[workbook.SheetNames[0]];
            if (!sheet) throw new Error('The workbook has no sheets');
            matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: '' });
          }
          const parsed = matrixToObjects(matrix);
          if (!parsed.rows.length) throw new Error('No data rows were found in the file');
          resolve(parsed);
        } catch (err) {
          reject(err);
        }
      };

      if (isCsv) reader.readAsText(file, 'utf-8');
      else reader.readAsArrayBuffer(file);
    });
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Could not read ' + file.name));
      reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
      reader.readAsDataURL(file);
    });
  }

  // -------------------------------------------------------- shared renderers --

  function statCard(label, value, unit, foot) {
    return el('div', { class: 'stat' }, [
      el('span', { class: 'label', text: label }),
      el('div', { class: 'value' }, [
        document.createTextNode(String(value)),
        unit ? el('span', { class: 'unit', text: unit }) : null
      ]),
      foot ? el('div', { class: 'foot' }, [].concat(foot)) : null
    ]);
  }

  function statePill(status) {
    const map = {
      running: ['pill--ok pill--live', 'Running'],
      completed: ['pill--ok', 'Completed'],
      paused: ['pill--warn', 'Paused'],
      blocked: ['pill--err', 'Blocked'],
      stopped: ['', 'Stopped'],
      ready: ['', 'Ready'],
      draft: ['', 'Draft']
    };
    const [cls, text] = map[status] || ['', status];
    return el('span', { class: 'pill ' + cls }, [el('span', { class: 'dot' }), el('span', { text })]);
  }

  function emptyState(title, detail, action) {
    return el('div', { class: 'empty' }, [
      el('div', { class: 'big', text: title }),
      el('p', { style: { margin: '0 auto', maxWidth: '44ch' }, text: detail }),
      action ? el('div', { style: { marginTop: '20px' } }, [action]) : null
    ]);
  }

  function connectionPill(conn) {
    if (!conn) return { cls: 'pill--err', text: 'No mailbox' };
    const state = conn.health ? conn.health.state : 'unknown';
    if (state === 'connected') return { cls: 'pill--ok', text: conn.email };
    if (state === 'invalid_credentials') return { cls: 'pill--err', text: 'Credentials rejected' };
    if (state === 'unavailable') return { cls: 'pill--warn', text: 'Server unreachable' };
    return { cls: 'pill--warn', text: conn.email };
  }

  // ==========================================================================
  //  SAMPLE CAMPAIGN  (simulation)
  // ==========================================================================

  /**
   * A self-contained rehearsal of the live monitor, so the shape of a running
   * campaign can be seen before a mailbox is connected or a list uploaded.
   *
   * Nothing here touches the network: the recipients are invented, and no mail
   * is sent. It is time-compressed on purpose - a real campaign paces itself at
   * 5s-2m between messages, which is unwatchable. Every other behaviour is
   * modelled honestly, including the transient retry and the permanent bounce,
   * because those are the moments worth recognising.
   */
  const DEMO = {
    firms: [
      ['Alexandra', 'Reyes', 'Reyes & Calloway LLP', 'Brooklyn', 'Kings'],
      ['Marcus', 'Hale', 'Hale Family Law', 'White Plains', 'Westchester'],
      ['Priya', 'Nandakumar', 'Nandakumar Legal', 'Queens', 'Queens'],
      ['Daniel', 'Okafor', 'Okafor & Stein', 'Manhattan', 'New York'],
      ['Sofia', 'Marchetti', 'Marchetti Matrimonial', 'Yonkers', 'Westchester'],
      ['Jonathan', 'Weiss', 'Weiss Advocates', 'Garden City', 'Nassau'],
      ['Grace', 'Lindqvist', 'Lindqvist Law Group', 'Buffalo', 'Erie'],
      ['Omar', 'Haddad', 'Haddad Counsel', 'Rochester', 'Monroe'],
      ['Eleanor', 'Whitfield', 'Whitfield & Roe', 'Albany', 'Albany'],
      ['Tobias', 'Braun', 'Braun Family Practice', 'Syracuse', 'Onondaga'],
      ['Renata', 'Silva', 'Silva Legal Partners', 'Staten Island', 'Richmond'],
      ['Aaron', 'Kimura', 'Kimura Law Offices', 'Bronx', 'Bronx'],
      ['Helena', 'Vasquez', 'Vasquez Matrimonial', 'Hempstead', 'Nassau'],
      ['Nathaniel', 'Crowe', 'Crowe & Associates', 'Poughkeepsie', 'Dutchess'],
      ['Ingrid', 'Solberg', 'Solberg Family Law', 'Ithaca', 'Tompkins'],
      ['Victor', 'Abramov', 'Abramov Legal', 'Brooklyn', 'Kings'],
      ['Camille', 'Beaumont', 'Beaumont Counsel', 'Manhattan', 'New York'],
      ['Isaac', 'Mendelsohn', 'Mendelsohn & Frye', 'Mineola', 'Nassau']
    ],
    // Fixed outcomes, so the rehearsal always shows a retry and a bounce.
    scripted: { 4: 'retry', 9: 'bounce', 14: 'retry' },
    // The real pacing window, matching DEFAULT_PACING in api/_engine.js.
    minGap: 5000,
    maxGap: 120000
  };

  const demo = {
    timer: null,
    tick: null,
    running: false,
    recipients: [],
    events: [],
    cursor: 0,
    startedAt: 0,
    nextAt: 0,
    sentAt: [],
    gaps: [],
    pendingGap: 0,
    nodes: null,
    speed: 1            // 1 = real time; >1 fast-forwards the rehearsal only
  };

  function demoSlug(first, last, firm) {
    const host = firm.toLowerCase().replace(/[^a-z]+/g, '').slice(0, 14) + '.example';
    return first[0].toLowerCase() + last.toLowerCase().replace(/[^a-z]/g, '') + '@' + host;
  }

  function demoReset() {
    demoStop();
    demo.recipients = DEMO.firms.map((f, i) => ({
      email: demoSlug(f[0], f[1], f[2]),
      first: f[0], firm: f[2], city: f[3], county: f[4],
      state: 'queued', attempts: 0, at: null, error: null,
      script: DEMO.scripted[i] || null
    }));
    demo.events = [];
    demo.cursor = 0;
    demo.sentAt = [];
    demo.gaps = [];
    demo.pendingGap = 0;
    demo.startedAt = 0;
    demo.nextAt = 0;
    demo.running = false;
  }

  function demoEvent(type, message, detail) {
    demo.events.unshift({ t: Date.now(), type, message, detail: detail || '' });
    if (demo.events.length > 60) demo.events.pop();
  }

  function demoStop() {
    clearTimeout(demo.timer);
    clearInterval(demo.tick);
    demo.timer = null;
    demo.tick = null;
  }

  function demoStart() {
    if (demo.running) return;
    if (demo.cursor === 0) {
      demo.startedAt = Date.now();
      demoEvent('connection', 'Connected to SMTP', 'smtp.example.com:465 · TLS');
      demoEvent('campaign', 'Personalization loaded', '5 merge fields across ' + demo.recipients.length + ' rows');
      demoEvent('campaign', 'Sample campaign started', 'Simulation — no mail leaves this browser');
    } else {
      demoEvent('campaign', 'Sample campaign resumed');
    }
    demo.running = true;
    demoSchedule();
    demoPaint();
  }

  function demoPause() {
    if (!demo.running) return;
    demo.running = false;
    demoStop();
    demoEvent('pacing', 'Sample campaign paused');
    demoPaint();
  }

  /**
   * Same uniform draw across the same 5s-2m window the server uses, so the
   * rehearsal shows the real rhythm. The speed divisor only compresses the
   * wall-clock wait; the gap that gets displayed is the true one.
   */
  function demoSchedule() {
    clearTimeout(demo.timer);
    const gap = DEMO.minGap + Math.random() * (DEMO.maxGap - DEMO.minGap);
    demo.pendingGap = gap;
    demo.nextAt = Date.now() + gap / demo.speed;
    demo.timer = setTimeout(demoSend, gap / demo.speed);
  }

  function demoSend() {
    const r = demo.recipients[demo.cursor];
    if (!r) return demoFinish();
    r.attempts += 1;
    // Book the gap we actually waited for, in real-campaign terms.
    demo.gaps.push(demo.pendingGap);

    if (r.script === 'retry' && r.attempts === 1) {
      r.state = 'retrying';
      r.error = '451 4.3.0 Temporary local problem';
      demoEvent('retry', 'Retry scheduled — ' + r.email, 'Transient 451, backing off before attempt 2');
    } else if (r.script === 'bounce') {
      r.state = 'failed';
      r.at = Date.now();
      r.error = '550 5.1.1 User unknown';
      demoEvent('failed', 'Permanent failure — ' + r.email, '550 5.1.1 User unknown · will not retry');
      demo.cursor += 1;
    } else {
      r.state = 'sent';
      r.at = Date.now();
      r.error = null;
      demo.sentAt.push(r.at);
      demoEvent('sent', 'Email sent — ' + r.email, 'Merged: ' + r.first + ' · ' + r.firm + ' · ' + r.county + ' County');
      demo.cursor += 1;
    }

    if (demo.cursor >= demo.recipients.length) return demoFinish();
    demoSchedule();
    demoPaint();
  }

  function demoFinish() {
    demo.running = false;
    demoStop();
    demo.nextAt = 0;
    demoEvent('campaign', 'Sample campaign completed', demoStats().sent + ' delivered · ' + demoStats().failed + ' failed');
    demoPaint();
  }

  function demoStats() {
    const s = { sent: 0, failed: 0, retrying: 0, queued: 0, total: demo.recipients.length };
    demo.recipients.forEach((r) => { s[r.state] += 1; });
    return s;
  }

  /**
   * Derived from the drawn gaps rather than the wall clock, so fast-forwarding
   * the rehearsal does not inflate the rate or shrink the ETA. These are the
   * numbers a real run at this pacing would show.
   */
  function demoMetrics() {
    const s = demoStats();
    const done = s.sent + s.failed;
    const gaps = demo.gaps;
    const elapsed = gaps.reduce((a, b) => a + b, 0);
    const avg = gaps.length ? elapsed / gaps.length : 0;
    return {
      stats: s,
      percent: s.total ? (done / s.total) * 100 : 0,
      remaining: s.total - done,
      avgIntervalMs: avg,
      ratePerHour: avg ? Math.round(3600000 / avg) : 0,
      elapsedMs: elapsed,
      etaMs: avg && s.total - done > 0 ? avg * (s.total - done) : null
    };
  }

  /**
   * A plain-language picture of the pipeline, for anyone who should not have to
   * read a table to know whether the thing is working. Four stops, a live wire,
   * and an envelope that visibly travels it. It is driven by the same state as
   * everything else on the panel - it never animates when nothing is happening.
   */
  function railIcon(kind) {
    const svg = (inner, cls) => {
      const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      s.setAttribute('viewBox', '0 0 24 24');
      s.setAttribute('width', '21');
      s.setAttribute('height', '21');
      s.setAttribute('fill', 'none');
      s.setAttribute('stroke', 'currentColor');
      s.setAttribute('stroke-width', '1.3');
      s.setAttribute('stroke-linecap', 'round');
      s.setAttribute('stroke-linejoin', 'round');
      s.innerHTML = inner;
      if (cls) s.setAttribute('class', cls);
      return s;
    };
    if (kind === 'list') return svg('<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>');
    if (kind === 'engine') return svg('<g class="gear"><circle cx="12" cy="12" r="3.2"/><path d="M12 2.6v2.6M12 18.8v2.6M21.4 12h-2.6M5.2 12H2.6M18.6 5.4l-1.9 1.9M7.3 16.7l-1.9 1.9M18.6 18.6l-1.9-1.9M7.3 7.3L5.4 5.4"/></g>');
    if (kind === 'mailbox') return svg('<rect x="2.5" y="5" width="19" height="14" rx="2"/><path d="M2.5 8.2l9.5 6 9.5-6"/>');
    return svg('<circle cx="12" cy="8.5" r="3.4"/><path d="M4.5 20a7.5 7.5 0 0115 0"/>');
  }

  function railNode(kind, cap, sub, extraClass) {
    return el('div', { class: 'rail-node ' + (extraClass || ''), 'data-on': '0' }, [
      el('div', { class: 'disc' }, [railIcon(kind)]),
      el('span', { class: 'cap', text: cap }),
      el('span', { class: 'sub', text: sub })
    ]);
  }

  function demoRail() {
    const nodes = {
      list: railNode('list', 'List', '18 recipients'),
      engine: railNode('engine', 'Kech', 'waiting out the gap', 'rail-node--engine'),
      mailbox: railNode('mailbox', 'Your mailbox', 'sends one at a time'),
      out: railNode('person', 'Recipient', 'personalised', 'rail-node--out')
    };
    const rail = el('div', { class: 'rail' }, [
      el('div', { class: 'wire' }),
      el('span', { class: 'pkt' }), el('span', { class: 'pkt' }), el('span', { class: 'pkt' }),
      nodes.list, nodes.engine, nodes.mailbox, nodes.out
    ]);
    return { rail, nodes };
  }

  /** Builds the panel once; demoPaint() mutates it in place so nothing flickers. */
  function demoPanel() {
    const ring = el('div', { class: 'ring' }, [
      el('div', { class: 'inner' }, [
        el('span', { class: 'pct', text: '0%' }),
        el('span', { class: 'cap', text: 'complete' })
      ])
    ]);
    const meter = el('div', { class: 'meter', style: { marginBottom: '14px' } }, [
      el('span', { class: 's-sent', style: { width: '0%' } }),
      el('span', { class: 's-retry', style: { width: '0%' } }),
      el('span', { class: 's-failed', style: { width: '0%' } })
    ]);
    const legendRow = el('div', { class: 'row row--wrap', style: { gap: '20px' } });
    const countdown = el('span', { class: 'num', style: { fontSize: '30px', letterSpacing: '-0.045em', fontWeight: '300' }, text: '--:--' });
    const countdownFoot = el('p', { class: 'hint', style: { marginTop: '6px' }, text: '' });
    const statsRow = el('div', { class: 'grid grid--4', style: { marginTop: '20px' } });
    const current = el('div', { class: 'hint truncate', style: { marginTop: '16px' }, text: '' });
    const tbody = el('tbody', {});
    const feed = el('div', { class: 'feed', style: { maxHeight: '300px' } });
    const livePill = el('span', { class: 'pill' }, [el('span', { class: 'dot' }), el('span', { class: 'txt', text: 'Idle' })]);

    const btnToggle = el('button', {
      class: 'btn btn--primary btn--sm',
      text: 'Run sample',
      onclick: () => {
        if (demo.running) return demoPause();
        // A finished run starts over rather than resuming past the end.
        if (demo.cursor >= demo.recipients.length) demoReset();
        demoStart();
      }
    });
    const btnReset = el('button', { class: 'btn btn--sm', text: 'Reset', onclick: () => { demoReset(); demoPaint(); } });

    const speed = el('select', { class: 'select', style: { width: 'auto', minWidth: '140px' }, onchange: (e) => {
      demo.speed = Number(e.target.value);
      if (demo.running) demoSchedule();       // apply immediately to the pending wait
      demoPaint();
    } }, [
      el('option', { value: '1', text: 'Real time (5s–2m)' }),
      el('option', { value: '10', text: 'Fast-forward ×10' }),
      el('option', { value: '40', text: 'Fast-forward ×40' })
    ]);
    speed.value = String(demo.speed);

    const railParts = demoRail();

    demo.nodes = { ring, meter, legendRow, countdown, countdownFoot, statsRow, current, tbody, feed, livePill, btnToggle,
                   rail: railParts.rail, railNodes: railParts.nodes };

    return el('div', { class: 'card card--glass card--pad-lg', style: { marginTop: '14px' } }, [
      el('div', { class: 'between', style: { marginBottom: '20px', flexWrap: 'wrap', gap: '14px' } }, [
        el('div', { style: { minWidth: 0 } }, [
          el('p', { class: 'eyebrow', text: 'Preview' }),
          el('h2', { class: 'h-md', style: { margin: '8px 0 6px' }, text: 'Sample campaign in progress' }),
          el('p', { class: 'hint', style: { maxWidth: '58ch' }, text: 'A rehearsal of the live monitor on invented recipients — no mail is sent. It draws each gap from the same 5s–2m random window a real campaign uses, so pacing looks exactly as it will in production.' })
        ]),
        el('div', { class: 'row row--wrap' }, [livePill, speed, btnToggle, btnReset])
      ]),

      railParts.rail,
      el('hr', { class: 'divider' }),

      el('div', { class: 'row', style: { gap: '30px', flexWrap: 'wrap', alignItems: 'center' } }, [
        ring,
        el('div', { style: { flex: '1', minWidth: '240px' } }, [meter, legendRow]),
        el('div', { style: { minWidth: '140px' } }, [
          el('span', { class: 'label', text: 'Next send in' }),
          el('div', { style: { marginTop: '8px' } }, [countdown]),
          countdownFoot
        ])
      ]),

      statsRow,
      current,
      el('hr', { class: 'divider' }),

      el('div', { class: 'grid grid--sidebar' }, [
        el('div', { class: 'table-wrap' }, [
          el('div', { class: 'table-scroll', style: { maxHeight: '300px' } }, [
            el('table', { class: 'data' }, [
              el('thead', {}, [el('tr', {}, [
                el('th', { text: 'Recipient' }),
                el('th', { text: 'Merged' }),
                el('th', { text: 'State' }),
                el('th', { class: 'num', text: 'Try' })
              ])]),
              tbody
            ])
          ])
        ]),
        el('div', {}, [
          el('span', { class: 'label', text: 'Activity' }),
          el('div', { style: { marginTop: '10px' } }, [feed])
        ])
      ])
    ]);
  }

  function demoPaint() {
    const n = demo.nodes;
    if (!n || !document.body.contains(n.ring)) return;
    const m = demoMetrics();
    const s = m.stats;
    const pct = (k) => (s.total ? (s[k] / s.total) * 100 : 0) + '%';

    n.ring.style.setProperty('--p', String(m.percent));
    $('.pct', n.ring).textContent = m.percent.toFixed(0) + '%';
    $('.s-sent', n.meter).style.width = pct('sent');
    $('.s-retry', n.meter).style.width = pct('retrying');
    $('.s-failed', n.meter).style.width = pct('failed');

    n.legendRow.innerHTML = '';
    [['Sent', s.sent, 'var(--ok)'], ['Retrying', s.retrying, 'var(--warn)'], ['Failed', s.failed, 'var(--err)'], ['Queued', s.queued, 'var(--faint)']]
      .forEach(([l, v, c]) => n.legendRow.appendChild(legend(l, v, c)));

    n.statsRow.innerHTML = '';
    [
      statCard('Sent', fmtNum(s.sent), '/ ' + fmtNum(s.total), [el('span', { text: fmtNum(m.remaining) + ' remaining' })]),
      statCard('Rate', fmtNum(m.ratePerHour), '/hr', [el('span', { text: m.avgIntervalMs ? 'avg gap ' + fmtDuration(m.avgIntervalMs, true) : 'measuring…' })]),
      statCard('Elapsed', fmtDuration(m.elapsedMs, true), null, [el('span', { text: demo.speed > 1 ? 'at real-time pacing' : demo.startedAt ? 'since ' + fmtTime(demo.startedAt) : 'not started' })]),
      statCard('Remaining', m.etaMs != null ? fmtDuration(m.etaMs, true) : '--', null, [el('span', { text: 'estimated' })])
    ].forEach((c) => n.statsRow.appendChild(c));

    const done = demo.cursor >= demo.recipients.length;
    n.livePill.className = 'pill ' + (demo.running ? 'pill--ok pill--live' : done ? 'pill--ok' : '');
    $('.txt', n.livePill).textContent = demo.running ? 'Running' : done ? 'Completed' : demo.cursor ? 'Paused' : 'Idle';
    n.btnToggle.textContent = demo.running ? 'Pause' : done ? 'Run again' : demo.cursor ? 'Resume' : 'Run sample';

    const next = demo.recipients[demo.cursor];
    n.current.textContent = demo.running && next ? 'Now sending to ' + next.email + ' — “Hello ' + next.first + ', …”' : '';

    // Rail: only alive while the campaign is.
    n.rail.classList.toggle('is-live', demo.running);
    const rn = n.railNodes;
    rn.list.dataset.on = '1';
    rn.engine.dataset.on = demo.running ? '1' : '0';
    rn.mailbox.dataset.on = demo.running ? '1' : '0';
    rn.out.dataset.on = s.sent ? '1' : '0';
    $('.sub', rn.list).textContent = fmtNum(s.queued) + ' still queued';
    $('.sub', rn.engine).textContent = demo.running ? 'pacing 5s–2m' : done ? 'finished' : 'idle';
    $('.sub', rn.mailbox).textContent = demo.running && next ? 'one at a time' : 'connected';
    $('.sub', rn.out).textContent = s.sent ? fmtNum(s.sent) + ' reached' : 'personalised';

    n.tbody.innerHTML = '';
    demo.recipients.forEach((r) => {
      n.tbody.appendChild(el('tr', {}, [
        el('td', {}, [el('div', { class: 'truncate', style: { maxWidth: '210px' }, title: r.email, text: r.email })]),
        el('td', {}, [el('span', { class: 'hint truncate', style: { maxWidth: '170px', display: 'block' }, title: r.firm + ' · ' + r.city, text: r.first + ' · ' + r.firm })]),
        el('td', {}, [el('span', { class: 'state state--' + r.state }, [
          el('span', { class: 'dot' }),
          el('span', { text: r.state === 'sent' && r.at ? fmtTime(r.at) : r.error ? r.error.slice(0, 22) : r.state })
        ])]),
        el('td', { class: 'num hint', text: r.attempts ? String(r.attempts) : '—' })
      ]));
    });

    n.feed.innerHTML = '';
    demo.events.forEach((ev) => n.feed.appendChild(feedRow(ev)));
  }

  /** Smooth countdown, decoupled from the send schedule. */
  function demoMountTimers() {
    clearInterval(demo.tick);
    demo.tick = setInterval(() => {
      const n = demo.nodes;
      if (!n || !document.body.contains(n.countdown)) return clearInterval(demo.tick);
      if (demo.running && demo.nextAt) {
        n.countdown.textContent = fmtClock(demo.nextAt - Date.now());
        // Name the gap that was actually drawn, so the randomness is visible
        // rather than something the user has to take on trust.
        n.countdownFoot.textContent = 'waiting ' + fmtDuration(demo.pendingGap, true) +
          ', drawn at random from 5s–2m' + (demo.speed > 1 ? ' (played ×' + demo.speed + ')' : '');
      } else {
        n.countdown.textContent = '--:--';
        n.countdownFoot.textContent = demo.running ? '' : 'paused';
      }
    }, 200);
  }

  // ==========================================================================
  //  VIEW - DASHBOARD
  // ==========================================================================

  async function viewDashboard(root) {
    root.appendChild(el('div', { class: 'hero' }, [
      el('p', { class: 'eyebrow', text: 'Console' }),
      el('h1', { class: 'display' }, [
        document.createTextNode('Campaign '),
        el('em', { text: 'control.' })
      ]),
      el('p', { class: 'lede', text: 'Everything below reflects what the server actually did — transport results only, never inferred opens or clicks.' })
    ]));

    if (!state.connection) {
      root.appendChild(el('div', { class: 'card card--glass card--pad-lg' }, [
        el('p', { class: 'eyebrow', text: 'Step one' }),
        el('h2', { class: 'h-lg', style: { margin: '10px 0 10px' }, text: 'Connect a sending mailbox' }),
        el('p', { class: 'lede', style: { marginBottom: '20px' }, text: 'Kech sends through your own mailbox over SMTP. Enter the address and password and it will find the right servers for you.' }),
        el('button', { class: 'btn btn--primary btn--lg', text: 'Set up connection', onclick: () => go('connection') })
      ]));
      mountSampleCampaign(root);
      return;
    }

    const skeleton = el('div', { class: 'grid grid--4' }, [1, 2, 3, 4].map(() => el('div', { class: 'stat' }, [el('div', { class: 'skeleton', style: { height: '14px', width: '50%' } }), el('div', { class: 'skeleton', style: { height: '32px', marginTop: '16px', width: '70%' } })])));
    root.appendChild(skeleton);

    // Needed for the pacing readout below; harmless if it fails.
    if (!state.settings) {
      try { state.settings = (await api('settings', { action: 'get' })).settings; } catch (_) {}
    }

    let analytics;
    try {
      analytics = (await api('campaign', { action: 'analytics' }));
    } catch (err) {
      skeleton.replaceWith(el('div', { class: 'card' }, [el('p', { class: 'hint hint--err', text: err.message })]));
      return;
    }
    state.analytics = analytics;

    const totals = analytics.totals;
    const successRate = analytics.successRate == null ? '--' : analytics.successRate.toFixed(1);

    skeleton.replaceWith(el('div', { class: 'grid grid--4' }, [
      statCard('Delivered', fmtNum(totals.sent), null, [el('span', { text: 'Accepted by the receiving server' })]),
      statCard('Success rate', successRate, '%', [el('span', { text: fmtNum(totals.failed) + ' permanent failures' })]),
      statCard('Recipients', fmtNum(totals.recipients), null, [el('span', { text: 'Across ' + fmtNum(totals.campaigns) + ' campaigns' })]),
      statCard('Average gap', analytics.avgIntervalMs ? fmtDuration(analytics.avgIntervalMs, true) : '--', null, [el('span', { text: 'Between consecutive sends' })])
    ]));

    // Send volume, last 14 days
    const max = Math.max(1, ...analytics.series.map((d) => d.sent));
    const today = new Date().toISOString().slice(0, 10);
    root.appendChild(el('div', { class: 'grid grid--sidebar', style: { marginTop: '14px' } }, [
      el('div', { class: 'card' }, [
        el('div', { class: 'between', style: { marginBottom: '20px' } }, [
          el('div', {}, [
            el('span', { class: 'label', text: 'Send volume' }),
            el('div', { class: 'h-md', style: { marginTop: '4px' }, text: 'Last 14 days' })
          ]),
          el('span', { class: 'pill' }, [el('span', { class: 'dot' }), el('span', { text: fmtNum(analytics.series.reduce((a, b) => a + b.sent, 0)) + ' sent' })])
        ]),
        el('div', { class: 'bars' }, analytics.series.map((d) => el('div', {
          class: 'b',
          'data-today': d.day === today ? '1' : '0',
          title: d.day + ': ' + d.sent + ' sent',
          style: { height: Math.max(2, (d.sent / max) * 100) + '%' }
        }))),
        el('div', { class: 'between', style: { marginTop: '10px' } }, [
          el('span', { class: 'hint', text: analytics.series[0].day }),
          el('span', { class: 'hint', text: 'today' })
        ])
      ]),

      el('div', { class: 'card' }, [
        el('span', { class: 'label', text: 'Sending identity' }),
        el('div', { class: 'h-md', style: { margin: '10px 0 2px' }, text: state.connection.email }),
        el('p', { class: 'hint', text: state.connection.provider ? state.connection.provider.label : state.connection.smtp.host }),
        el('hr', { class: 'divider' }),
        infoRow('Domain', state.connection.domain),
        infoRow('SMTP', state.connection.smtp.host + ':' + state.connection.smtp.port + (state.connection.smtp.secure ? ' · TLS' : ' · STARTTLS')),
        infoRow('IMAP', state.connection.imap ? state.connection.imap.host + ':' + state.connection.imap.port : 'Not configured'),
        infoRow('Daily limit', state.connection.dailyLimit ? fmtNum(state.connection.dailyLimit) + ' messages' : 'Not published by provider'),
        infoRow('Last verified', fmtDateTime(state.connection.verifiedAt)),
        infoRow('Sending gap', pacingLabel()),
        el('div', { style: { marginTop: '16px' } }, [
          el('button', { class: 'btn btn--block', text: 'Manage connection', onclick: () => go('connection') })
        ])
      ])
    ]));

    // Recent campaigns
    const campaigns = (await api('campaign', { action: 'list' })).campaigns;
    state.campaigns = campaigns;

    const recent = campaigns.slice(0, 5);
    root.appendChild(el('div', { style: { marginTop: '26px' } }, [
      el('div', { class: 'between', style: { marginBottom: '14px' } }, [
        el('h2', { class: 'h-md', text: 'Recent campaigns' }),
        el('button', { class: 'btn btn--sm', text: 'New campaign', onclick: () => go('compose') })
      ]),
      recent.length ? campaignTable(recent) : el('div', { class: 'table-wrap' }, [
        emptyState('No campaigns yet', 'Upload a recipient list, write the message once, and Kech handles the rest.',
          el('button', { class: 'btn btn--primary', text: 'Build a campaign', onclick: () => go('compose') }))
      ])
    ]));

    mountSampleCampaign(root);
  }

  /** Drops the rehearsal panel in and starts its clocks. */
  function mountSampleCampaign(root) {
    if (!demo.recipients.length) demoReset();
    root.appendChild(demoPanel());
    demoPaint();
    demoMountTimers();
  }

  /** The pacing window currently in force, stated in plain units. */
  function pacingLabel() {
    const p = (state.settings && state.settings.pacing) || {};
    const min = p.minDelayMs != null ? p.minDelayMs : 5000;
    const max = p.maxDelayMs != null ? p.maxDelayMs : 120000;
    if (p.randomize === false) return 'every ' + fmtDuration(min, true) + ', fixed';
    return fmtDuration(min, true) + '–' + fmtDuration(max, true) + ', randomised';
  }

  function infoRow(label, value) {
    return el('div', { class: 'between', style: { padding: '7px 0' } }, [
      el('span', { class: 'hint', text: label }),
      el('span', { class: 'truncate', style: { fontSize: '12.5px', maxWidth: '60%', textAlign: 'right' }, title: String(value), text: String(value) })
    ]);
  }

  function campaignTable(campaigns) {
    return el('div', { class: 'table-wrap' }, [
      el('div', { class: 'table-scroll' }, [
        el('table', { class: 'data' }, [
          el('thead', {}, [el('tr', {}, [
            el('th', { text: 'Campaign' }),
            el('th', { text: 'Status' }),
            el('th', { class: 'num', text: 'Recipients' }),
            el('th', { class: 'num', text: 'Sent' }),
            el('th', { class: 'num', text: 'Failed' }),
            el('th', { class: 'num', text: 'Progress' }),
            el('th', { text: 'Created' }),
            el('th', {})
          ])]),
          el('tbody', {}, campaigns.map((c) => {
            const settled = c.stats.sent + c.stats.failed + c.stats.skipped;
            const pct = c.stats.total ? (settled / c.stats.total) * 100 : 0;
            return el('tr', {}, [
              el('td', {}, [
                el('div', { class: 'truncate', style: { maxWidth: '260px' }, text: c.name }),
                el('div', { class: 'hint truncate', style: { maxWidth: '260px' }, text: c.subject || '(no subject)' })
              ]),
              el('td', {}, [statePill(c.status)]),
              el('td', { class: 'num', text: fmtNum(c.stats.total) }),
              el('td', { class: 'num', text: fmtNum(c.stats.sent) }),
              el('td', { class: 'num', text: c.stats.failed ? fmtNum(c.stats.failed) : '—' }),
              el('td', { class: 'num', style: { minWidth: '110px' } }, [
                el('div', { class: 'row', style: { justifyContent: 'flex-end', gap: '8px' } }, [
                  el('span', { class: 'num', text: pct.toFixed(0) + '%' }),
                  el('div', { class: 'progress', style: { width: '54px' } }, [el('div', { class: 'bar', style: { width: pct + '%' } })])
                ])
              ]),
              el('td', { class: 'hint', text: fmtDate(c.createdAt) }),
              el('td', {}, [el('button', { class: 'btn btn--sm', text: 'Open', onclick: () => openCampaign(c.id) })])
            ]);
          }))
        ])
      ])
    ]);
  }

  // ==========================================================================
  //  VIEW - CONNECTION
  // ==========================================================================

  function viewConnection(root) {
    root.appendChild(el('div', { class: 'hero' }, [
      el('p', { class: 'eyebrow', text: 'Configuration' }),
      el('h1', { class: 'h-lg', style: { margin: '10px 0' }, text: state.connection ? 'Sending mailbox' : 'Connect a mailbox' }),
      el('p', { class: 'lede', text: 'Kech sends through your own mail server. The password is encrypted with AES-256-GCM before it is stored and is only decrypted inside the sending worker.' })
    ]));

    if (state.connection) {
      root.appendChild(connectedPanel());
      root.appendChild(el('div', { style: { marginTop: '22px' } }, [
        el('details', {}, [
          el('summary', { class: 'label', style: { cursor: 'pointer', padding: '8px 0' }, text: 'Replace this connection' }),
          el('div', { style: { marginTop: '14px' } }, [connectionForm()])
        ])
      ]));
    } else {
      root.appendChild(connectionForm());
    }
  }

  function connectedPanel() {
    const conn = state.connection;
    const health = conn.health || { state: 'unknown' };
    const healthMap = {
      connected: ['pill--ok', 'Connected'],
      invalid_credentials: ['pill--err', 'Credentials rejected'],
      unavailable: ['pill--warn', 'Temporarily unavailable'],
      error: ['pill--err', 'Error'],
      unknown: ['pill--warn', 'Not verified']
    };
    const [cls, text] = healthMap[health.state] || healthMap.unknown;

    return el('div', { class: 'grid grid--sidebar' }, [
      el('div', { class: 'card card--pad-lg' }, [
        el('div', { class: 'between', style: { marginBottom: '20px' } }, [
          el('div', {}, [
            el('span', { class: 'label', text: 'Sender identity' }),
            el('div', { class: 'h-lg', style: { marginTop: '6px' }, text: conn.email })
          ]),
          el('span', { class: 'pill ' + cls }, [el('span', { class: 'dot' }), el('span', { text })])
        ]),
        health.message ? el('p', { class: 'hint', style: { marginBottom: '16px' }, text: health.message }) : null,
        el('hr', { class: 'divider' }),
        el('div', { class: 'grid grid--2' }, [
          el('div', {}, [
            el('span', { class: 'label', text: 'Outgoing · SMTP' }),
            el('p', { class: 'mono', style: { marginTop: '8px' }, text: conn.smtp.host }),
            el('p', { class: 'hint', text: 'Port ' + conn.smtp.port + ' · ' + (conn.smtp.secure ? 'Implicit TLS' : 'STARTTLS') }),
            el('p', { class: 'hint', text: 'User ' + conn.smtp.user })
          ]),
          el('div', {}, [
            el('span', { class: 'label', text: 'Incoming · IMAP' }),
            conn.imap ? el('div', {}, [
              el('p', { class: 'mono', style: { marginTop: '8px' }, text: conn.imap.host }),
              el('p', { class: 'hint', text: 'Port ' + conn.imap.port + ' · TLS' }),
              el('p', { class: 'hint', text: 'User ' + conn.imap.user })
            ]) : el('p', { class: 'hint', style: { marginTop: '8px' }, text: 'Not configured. IMAP is optional — it confirms mailbox access but sending does not need it.' })
          ])
        ]),
        el('hr', { class: 'divider' }),
        el('div', { class: 'row row--wrap' }, [
          el('button', { class: 'btn', text: 'Re-test connection', onclick: recheckConnection }),
          el('button', {
            class: 'btn btn--danger', text: 'Disconnect', onclick: async () => {
              if (!(await confirmDialog('Disconnect mailbox', 'Running campaigns will stop until a mailbox is connected again. The stored password will be deleted.', 'Disconnect'))) return;
              await api('connection', { action: 'disconnect' });
              state.connection = null;
              toast('Mailbox disconnected', 'warn');
              render();
            }
          })
        ])
      ]),

      el('div', { class: 'card' }, [
        el('span', { class: 'label', text: 'Security posture' }),
        el('div', { style: { marginTop: '14px' } }, [
          secRow('Password storage', 'AES-256-GCM, server-side only'),
          secRow('Browser exposure', 'Never sent back to this page'),
          secRow('Session', 'HttpOnly cookie, 8 hour expiry'),
          secRow('Transport', 'TLS 1.2 minimum to your mail server'),
          secRow('Provider limits', 'Respected — never circumvented')
        ]),
        conn.provider && conn.provider.note ? el('div', { style: { marginTop: '18px', padding: '13px', background: 'var(--warn-dim)', borderRadius: '10px', border: '1px solid rgba(230,201,141,0.2)' } }, [
          el('p', { class: 'hint', style: { color: 'var(--warn)' }, text: conn.provider.note })
        ]) : null
      ])
    ]);
  }

  function secRow(label, value) {
    return el('div', { style: { display: 'flex', gap: '10px', padding: '8px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' } }, [
      el('span', { class: 'state state--sent' }, [el('span', { class: 'dot' })]),
      el('div', {}, [
        el('div', { style: { fontSize: '12.5px' }, text: label }),
        el('div', { class: 'hint', text: value })
      ])
    ]);
  }

  function connectionForm() {
    let discovered = null;
    let manual = false;

    const emailInput = el('input', { class: 'input', type: 'email', placeholder: 'campaigns@yourfirm.com', autocomplete: 'username' });
    const passInput = el('input', { class: 'input', type: 'password', placeholder: 'Password or app password', autocomplete: 'current-password' });
    const nameInput = el('input', { class: 'input', type: 'text', placeholder: 'Firm Outreach' });

    const smtpHost = el('input', { class: 'input', placeholder: 'smtp.yourfirm.com' });
    const smtpPort = el('input', { class: 'input num', type: 'number', placeholder: '465' });
    const smtpSecure = el('select', { class: 'select' }, [
      el('option', { value: 'true', text: 'Implicit TLS (465)' }),
      el('option', { value: 'false', text: 'STARTTLS (587)' })
    ]);
    const imapHost = el('input', { class: 'input', placeholder: 'imap.yourfirm.com' });
    const imapPort = el('input', { class: 'input num', type: 'number', placeholder: '993' });

    const discoveryBox = el('div', { hidden: true });
    const resultBox = el('div', { hidden: true, style: { marginTop: '18px' } });

    const manualPanel = el('div', { hidden: true, style: { marginTop: '18px' } }, [
      el('hr', { class: 'divider' }),
      el('p', { class: 'label', style: { marginBottom: '12px' }, text: 'Outgoing · SMTP' }),
      el('div', { class: 'grid grid--3' }, [
        el('div', { class: 'field' }, [el('label', { class: 'label', text: 'Host' }), smtpHost]),
        el('div', { class: 'field' }, [el('label', { class: 'label', text: 'Port' }), smtpPort]),
        el('div', { class: 'field' }, [el('label', { class: 'label', text: 'Encryption' }), smtpSecure])
      ]),
      el('p', { class: 'label', style: { margin: '18px 0 12px' }, text: 'Incoming · IMAP (optional)' }),
      el('div', { class: 'grid grid--3' }, [
        el('div', { class: 'field' }, [el('label', { class: 'label', text: 'Host' }), imapHost]),
        el('div', { class: 'field' }, [el('label', { class: 'label', text: 'Port' }), imapPort]),
        el('div', {})
      ])
    ]);

    const testBtn = el('button', { class: 'btn', type: 'button', text: 'Test connection' });
    const saveBtn = el('button', { class: 'btn btn--primary', type: 'button', text: 'Test and save' });

    // Autodiscovery fires as soon as a plausible address is typed.
    const runDiscovery = debounce(async () => {
      const email = emailInput.value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { discoveryBox.hidden = true; return; }
      try {
        discovered = await api('connection', { action: 'discover', email });
        discoveryBox.hidden = false;
        discoveryBox.innerHTML = '';
        discoveryBox.appendChild(el('div', { style: { marginTop: '14px', padding: '14px', border: '1px solid var(--line)', borderRadius: '12px', background: 'var(--surface-2)' } }, [
          el('div', { class: 'between' }, [
            el('div', {}, [
              el('span', { class: 'label', text: 'Detected' }),
              el('div', { style: { marginTop: '5px', fontSize: '13.5px' }, text: discovered.provider ? discovered.provider.label : 'Custom mail server' }),
              el('p', { class: 'hint', style: { marginTop: '3px' }, text: discovered.suggested.smtp ? discovered.suggested.smtp.host + ':' + discovered.suggested.smtp.port : 'No published settings — we will probe common host names.' })
            ]),
            el('span', { class: 'pill ' + (discovered.provider ? 'pill--ok' : '') }, [
              el('span', { class: 'dot' }),
              el('span', { text: discovered.provider ? 'via ' + discovered.provider.source : 'unknown' })
            ])
          ]),
          discovered.provider && discovered.provider.note
            ? el('p', { class: 'hint', style: { marginTop: '11px', color: 'var(--warn)' }, text: discovered.provider.note })
            : null
        ]));
        if (discovered.suggested.smtp) {
          smtpHost.placeholder = discovered.suggested.smtp.host;
          smtpPort.placeholder = String(discovered.suggested.smtp.port);
        }
        if (discovered.suggested.imap) {
          imapHost.placeholder = discovered.suggested.imap.host;
          imapPort.placeholder = String(discovered.suggested.imap.port);
        }
      } catch (_) { discoveryBox.hidden = true; }
    }, 550);

    emailInput.addEventListener('input', runDiscovery);

    function payload() {
      const body = {
        email: emailInput.value.trim(),
        password: passInput.value,
        fromName: nameInput.value.trim()
      };
      if (manual && smtpHost.value.trim()) {
        body.smtp = { host: smtpHost.value.trim(), port: Number(smtpPort.value) || 465, secure: smtpSecure.value === 'true' };
      }
      if (manual && imapHost.value.trim()) {
        body.imap = { host: imapHost.value.trim(), port: Number(imapPort.value) || 993, secure: true };
      }
      return body;
    }

    function renderResult(data) {
      resultBox.hidden = false;
      resultBox.innerHTML = '';
      const line = (service, result) => {
        if (!result) return null;
        return el('div', { class: 'check-row', 'data-level': result.ok ? 'pass' : 'error' }, [
          el('span', { class: 'mark', text: result.ok ? '✓' : '!' }),
          el('div', {}, [
            el('div', { class: 't', text: service + (result.config ? ' · ' + result.config.host + ':' + result.config.port : '') }),
            el('div', { class: 'd', text: result.message })
          ])
        ]);
      };
      resultBox.appendChild(el('div', { class: 'card' }, [
        el('span', { class: 'label', text: 'Connection test' }),
        el('div', { style: { marginTop: '10px' } }, [
          line('SMTP — outgoing', data.smtp),
          line('IMAP — incoming', data.imap)
        ]),
        !data.smtp.ok && data.attempts && data.attempts.length > 1
          ? el('details', { style: { marginTop: '12px' } }, [
            el('summary', { class: 'hint', style: { cursor: 'pointer' }, text: 'Show all ' + data.attempts.length + ' attempts' }),
            el('div', { style: { marginTop: '10px' } }, data.attempts.map((a) => el('p', { class: 'hint mono', text: a.service + ' ' + a.host + ':' + a.port + ' — ' + a.message })))
          ])
          : null,
        !data.smtp.ok ? el('p', { class: 'hint', style: { marginTop: '12px' }, text: 'If your provider uses 2-factor authentication, generate an app-specific password rather than using the account password.' }) : null
      ]));
      saveBtn.disabled = false;
    }

    async function withBusy(button, label, fn) {
      const original = button.textContent;
      button.disabled = true;
      button.innerHTML = '';
      button.appendChild(el('span', { class: 'spin' }));
      button.appendChild(document.createTextNode(label));
      try { await fn(); } finally {
        button.disabled = false;
        button.textContent = original;
      }
    }

    testBtn.onclick = () => {
      if (!emailInput.value.trim() || !passInput.value) return toast('Enter the mailbox address and password', 'warn');
      withBusy(testBtn, 'Testing…', async () => {
        try { renderResult(await api('connection', Object.assign({ action: 'test' }, payload()))); }
        catch (err) { toast(err.message, 'err'); }
      });
    };

    saveBtn.onclick = () => {
      withBusy(saveBtn, 'Saving…', async () => {
        try {
          const data = await api('connection', Object.assign({ action: 'save' }, payload()));
          state.connection = data.connection;
          passInput.value = '';
          toast('Mailbox connected and verified', 'ok');
          go('dashboard');
        } catch (err) {
          toast(err.message, 'err');
          if (err.payload && err.payload.detail) renderResult(err.payload.detail);
        }
      });
    };

    return el('div', { class: 'card card--pad-lg', style: { maxWidth: '760px' } }, [
      el('div', { class: 'grid grid--2' }, [
        el('div', { class: 'field' }, [el('label', { class: 'label', text: 'Mailbox address' }), emailInput]),
        el('div', { class: 'field' }, [el('label', { class: 'label', text: 'Password' }), passInput])
      ]),
      el('div', { class: 'field', style: { marginTop: '14px' } }, [
        el('label', { class: 'label', text: 'Display name (optional)' }),
        nameInput,
        el('p', { class: 'hint', text: 'Shown as the sender name. Leave blank to send from the bare address.' })
      ]),
      discoveryBox,
      el('label', { class: 'switch', style: { marginTop: '18px' } }, [
        el('input', {
          type: 'checkbox', onchange: (e) => { manual = e.target.checked; manualPanel.hidden = !manual; }
        }),
        el('span', { class: 'track' }),
        el('span', { style: { fontSize: '13px' }, text: 'Enter server settings manually' })
      ]),
      manualPanel,
      el('div', { class: 'row', style: { marginTop: '22px' } }, [testBtn, saveBtn]),
      resultBox
    ]);
  }

  async function recheckConnection() {
    const dismiss = toast('Re-testing connection…', 'info', 30000);
    try {
      const data = await api('connection', { action: 'recheck' });
      state.connection = data.connection;
      dismiss();
      const ok = data.connection.health.state === 'connected';
      toast(ok ? 'Connection healthy' : data.connection.health.message, ok ? 'ok' : 'err');
      updateChrome();
      if (state.route === 'connection' || state.route === 'dashboard') render();
    } catch (err) {
      dismiss();
      toast(err.message, 'err');
    }
  }

  // ==========================================================================
  //  VIEW - COMPOSE
  // ==========================================================================

  function viewCompose(root) {
    if (!state.connection) {
      root.appendChild(emptyState('Connect a mailbox first', 'A campaign needs somewhere to send from.',
        el('button', { class: 'btn btn--primary', text: 'Set up connection', onclick: () => go('connection') })));
      return;
    }

    const draft = state.draft;

    root.appendChild(el('div', { class: 'hero' }, [
      el('p', { class: 'eyebrow', text: 'New campaign' }),
      el('h1', { class: 'h-lg', style: { margin: '10px 0' }, text: 'Compose' }),
      el('p', { class: 'lede', text: 'Upload the list, write the message once, and Kech personalises every copy from the spreadsheet columns.' })
    ]));

    const recipientsSection = el('div', { class: 'card card--pad-lg' });
    const messageSection = el('div', { class: 'card card--pad-lg', style: { marginTop: '14px' } });
    const attachSection = el('div', { class: 'card card--pad-lg', style: { marginTop: '14px' } });
    const pacingSection = el('div', { class: 'card card--pad-lg', style: { marginTop: '14px' } });
    const launchSection = el('div', { style: { marginTop: '14px' } });

    root.appendChild(recipientsSection);
    root.appendChild(messageSection);
    root.appendChild(attachSection);
    root.appendChild(pacingSection);
    root.appendChild(launchSection);

    renderRecipients();
    renderMessage();
    renderAttachments();
    renderPacing();
    renderLaunch();

    // ---- 1. recipients ----
    function renderRecipients() {
      recipientsSection.innerHTML = '';
      recipientsSection.appendChild(sectionHead('01', 'Recipients', 'Excel or CSV. The email column is detected automatically.'));

      if (!draft.rows.length) {
        const zone = el('div', { class: 'dropzone' }, [
          el('div', { class: 'big', text: 'Drop a spreadsheet here' }),
          el('p', { class: 'hint', text: '.xlsx, .xls, .csv or .tsv — up to 20,000 rows' })
        ]);
        const input = el('input', { type: 'file', accept: '.xlsx,.xls,.csv,.tsv,.txt', hidden: true, onchange: (e) => { if (e.target.files[0]) loadFile(e.target.files[0]); } });
        zone.onclick = () => input.click();
        zone.ondragover = (e) => { e.preventDefault(); zone.classList.add('is-over'); };
        zone.ondragleave = () => zone.classList.remove('is-over');
        zone.ondrop = (e) => {
          e.preventDefault();
          zone.classList.remove('is-over');
          if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
        };
        recipientsSection.appendChild(zone);
        recipientsSection.appendChild(input);
        return;
      }

      const valid = draft.rows.filter((r) => EMAIL_SHAPE.test(String(r[draft.emailField] || '').trim().replace(/.*<|>.*/g, '')));
      const unique = new Set(valid.map((r) => String(r[draft.emailField]).trim().toLowerCase())).size;
      const roles = detectRoles(draft.columns);

      recipientsSection.appendChild(el('div', { class: 'between', style: { marginBottom: '16px' } }, [
        el('div', {}, [
          el('div', { class: 'h-sm', text: draft.fileName }),
          el('p', { class: 'hint', text: fmtNum(draft.rows.length) + ' rows · ' + draft.columns.length + ' columns' })
        ]),
        el('button', { class: 'btn btn--sm', text: 'Replace file', onclick: () => { draft.rows = []; draft.columns = []; draft.emailField = ''; renderRecipients(); renderMessage(); renderLaunch(); } })
      ]));

      recipientsSection.appendChild(el('div', { class: 'grid grid--4', style: { marginBottom: '18px' } }, [
        miniStat('Rows', fmtNum(draft.rows.length)),
        miniStat('Valid addresses', fmtNum(valid.length)),
        miniStat('Unique', fmtNum(unique)),
        miniStat('Duplicates', fmtNum(valid.length - unique))
      ]));

      const select = el('select', { class: 'select', onchange: (e) => { draft.emailField = e.target.value; renderRecipients(); renderLaunch(); } },
        draft.columns.map((c) => el('option', { value: c, selected: c === draft.emailField, text: c })));

      recipientsSection.appendChild(el('div', { class: 'grid grid--2', style: { marginBottom: '18px' } }, [
        el('div', { class: 'field' }, [el('label', { class: 'label', text: 'Email column' }), select]),
        el('div', {}, [
          el('span', { class: 'label', text: 'Personalisation detected' }),
          el('div', { class: 'row row--wrap', style: { marginTop: '8px' } },
            roles.length
              ? roles.map((r) => el('span', { class: 'chip', title: 'Column: ' + r.column, text: '{{' + r.role + '}}' }))
              : [el('span', { class: 'hint', text: 'No standard fields recognised — every column is still usable as a variable.' })])
        ])
      ]));

      // Preview table
      const previewCols = draft.columns.slice(0, 6);
      recipientsSection.appendChild(el('div', { class: 'table-wrap' }, [
        el('div', { class: 'table-scroll', style: { maxHeight: '300px' } }, [
          el('table', { class: 'data' }, [
            el('thead', {}, [el('tr', {}, previewCols.map((c) => el('th', { text: c + (c === draft.emailField ? '  ·  email' : '') })))]),
            el('tbody', {}, draft.rows.slice(0, 25).map((row) => {
              const address = String(row[draft.emailField] || '').trim();
              const bad = !EMAIL_SHAPE.test(address.replace(/.*<|>.*/g, ''));
              return el('tr', {}, previewCols.map((c) => el('td', {
                style: c === draft.emailField && bad ? { color: 'var(--err)' } : null,
                title: String(row[c] || '')
              }, [el('span', { class: 'truncate', style: { display: 'block', maxWidth: '220px' }, text: String(row[c] || '—') })])));
            }))
          ])
        ])
      ]));
      recipientsSection.appendChild(el('p', { class: 'hint', style: { marginTop: '10px' }, text: 'Showing the first 25 rows. Duplicates, malformed addresses and previously suppressed contacts are removed when the campaign is created.' }));
    }

    async function loadFile(file) {
      try {
        const parsed = await readSpreadsheet(file);
        draft.rows = parsed.rows;
        draft.columns = parsed.columns;
        draft.fileName = file.name;
        draft.emailField = detectEmailColumn(parsed.columns, parsed.rows) || parsed.columns[0];
        if (!draft.name) draft.name = file.name.replace(/\.[^.]+$/, '') + ' outreach';
        toast(fmtNum(parsed.rows.length) + ' rows imported from ' + file.name, 'ok');
        renderRecipients();
        renderMessage();
        renderLaunch();
      } catch (err) {
        toast(err.message, 'err');
      }
    }

    // ---- 2. message ----
    function renderMessage() {
      messageSection.innerHTML = '';
      messageSection.appendChild(sectionHead('02', 'Message', 'Insert {{variables}} from any spreadsheet column. Add a fallback with {{column|default}}.'));

      const nameInput = el('input', { class: 'input', value: draft.name, placeholder: 'Q1 attorney outreach', oninput: (e) => { draft.name = e.target.value; } });
      const subjectInput = el('input', { class: 'input', value: draft.subject, placeholder: 'A quick note for {{first_name}}', oninput: (e) => { draft.subject = e.target.value; schedulePreview(); renderLaunch(); } });

      const previewBox = el('div');
      const schedulePreview = debounce(renderPreview, 260);

      // The three authoring modes share one body; switching converts between
      // HTML and plain text so nothing is silently lost.
      const mode = draft.editorMode || 'rich';
      draft.isHtml = mode !== 'text';

      let bodyEditor;       // the focusable element for this mode
      let getBody;          // reads the current body out of the editor

      if (mode === 'rich') {
        bodyEditor = el('div', {
          class: 'rte',
          contenteditable: 'true',
          spellcheck: 'true',
          role: 'textbox',
          'aria-multiline': 'true',
          'aria-label': 'Email body'
        });
        bodyEditor.innerHTML = draft.body ? sanitize(draft.body) : '';
        getBody = () => bodyEditor.innerHTML;

        bodyEditor.addEventListener('input', () => { draft.body = getBody(); schedulePreview(); renderLaunch(); });

        // Paste as sanitised HTML so a Word or browser paste cannot smuggle in
        // scripts, styles or absurd markup.
        bodyEditor.addEventListener('paste', (e) => {
          e.preventDefault();
          const html = e.clipboardData.getData('text/html');
          const text = e.clipboardData.getData('text/plain');
          if (html) document.execCommand('insertHTML', false, sanitize(html));
          else document.execCommand('insertText', false, text);
        });
      } else {
        bodyEditor = el('textarea', {
          class: 'textarea' + (mode === 'html' ? ' textarea--code' : ''),
          rows: '14',
          placeholder: mode === 'html' ? '<p>Hello {{first_name}},</p>' : 'Hello {{first_name}},',
          oninput: (e) => { draft.body = e.target.value; schedulePreview(); renderLaunch(); }
        });
        bodyEditor.value = draft.body;
        getBody = () => bodyEditor.value;
      }

      function switchMode(next) {
        if (next === mode) return;
        const current = getBody();
        if (mode !== 'text' && next === 'text') draft.body = htmlToText(current);
        else if (mode === 'text' && next !== 'text') draft.body = textToHtml(current);
        else draft.body = current;
        draft.editorMode = next;
        renderMessage();
      }

      /** Insert a merge token wherever the caret is, in any mode. */
      function insertToken(token) {
        const text = '{{' + token + '}}';
        const target = document.activeElement === subjectInput ? subjectInput : bodyEditor;

        if (target === bodyEditor && mode === 'rich') {
          bodyEditor.focus();
          document.execCommand('insertText', false, text);
          draft.body = getBody();
        } else {
          const start = target.selectionStart != null ? target.selectionStart : target.value.length;
          const end = target.selectionEnd != null ? target.selectionEnd : start;
          target.value = target.value.slice(0, start) + text + target.value.slice(end);
          target.focus();
          target.selectionStart = target.selectionEnd = start + text.length;
          if (target === subjectInput) draft.subject = target.value;
          else draft.body = target.value;
        }
        schedulePreview();
        renderLaunch();
      }

      function renderPreview() {
        const sample = draft.rows[0] || {};
        const rendered = renderTemplate(draft.body, sample);
        const subject = renderTemplate(draft.subject, sample);
        previewBox.innerHTML = '';
        previewBox.appendChild(el('div', { class: 'preview-head' }, [
          el('div', { class: 'between' }, [
            el('div', { style: { minWidth: 0 } }, [
              el('div', { class: 'truncate', style: { fontSize: '13.5px' }, text: subject || '(no subject)' }),
              el('p', { class: 'hint truncate', text: 'From ' + (state.connection.fromName ? state.connection.fromName + ' <' + state.connection.email + '>' : state.connection.email) + '  ·  To ' + (sample[draft.emailField] || 'recipient@example.com') })
            ]),
            el('span', { class: 'pill', style: { flex: 'none' } }, [el('span', { class: 'dot' }), el('span', { text: 'Row 1' })])
          ])
        ]));
        const frame = el('div', { class: 'preview-frame' });
        if (draft.isHtml) frame.innerHTML = sanitize(rendered || '<p style="color:#999">Nothing written yet.</p>');
        else frame.appendChild(el('pre', { style: { whiteSpace: 'pre-wrap', margin: '0', fontFamily: 'inherit' }, text: rendered || 'Nothing written yet.' }));
        previewBox.appendChild(frame);

        const tokens = collectTokens(draft.subject + ' ' + draft.body);
        const available = new Set(draft.columns.map(normKey));
        if (tokens.length) {
          previewBox.appendChild(el('div', { class: 'row row--wrap', style: { marginTop: '12px' } },
            tokens.map((t) => {
              const ok = available.has(normKey(t));
              return el('span', { class: 'chip' + (ok ? '' : ' chip--off'), title: ok ? 'Resolves from the spreadsheet' : 'No matching column — renders empty unless a fallback is set', text: '{{' + t + '}}' });
            })));
        }
      }

      messageSection.appendChild(el('div', { class: 'field', style: { marginBottom: '14px' } }, [
        el('label', { class: 'label', text: 'Campaign name' }), nameInput
      ]));
      messageSection.appendChild(el('div', { class: 'field', style: { marginBottom: '14px' } }, [
        el('label', { class: 'label', text: 'Subject' }), subjectInput
      ]));

      messageSection.appendChild(el('div', { class: 'between', style: { marginBottom: '10px', flexWrap: 'wrap', gap: '10px' } }, [
        el('span', { class: 'label', text: 'Body' }),
        el('div', { class: 'tabs' }, [
          el('button', { class: 'tab' + (mode === 'rich' ? ' is-active' : ''), text: 'Rich text', onclick: () => switchMode('rich') }),
          el('button', { class: 'tab' + (mode === 'html' ? ' is-active' : ''), text: 'HTML', onclick: () => switchMode('html') }),
          el('button', { class: 'tab' + (mode === 'text' ? ' is-active' : ''), text: 'Plain text', onclick: () => switchMode('text') })
        ])
      ]));

      if (mode === 'rich') {
        const exec = (command, value) => {
          bodyEditor.focus();
          document.execCommand(command, false, value || null);
          draft.body = getBody();
          schedulePreview();
          renderLaunch();
        };

        const tool = (label, title, command, value) => el('button', {
          class: 'rte-btn', type: 'button', title,
          onmousedown: (e) => e.preventDefault(),   // keep the caret where it is
          onclick: () => exec(command, value),
          html: label
        });

        messageSection.appendChild(el('div', { class: 'rte-toolbar' }, [
          tool('<b>B</b>', 'Bold', 'bold'),
          tool('<i>I</i>', 'Italic', 'italic'),
          tool('<u>U</u>', 'Underline', 'underline'),
          el('span', { class: 'rte-sep' }),
          tool('H', 'Heading', 'formatBlock', '<h2>'),
          tool('&para;', 'Paragraph', 'formatBlock', '<p>'),
          el('span', { class: 'rte-sep' }),
          tool('&bull;&nbsp;List', 'Bulleted list', 'insertUnorderedList'),
          tool('1.&nbsp;List', 'Numbered list', 'insertOrderedList'),
          el('span', { class: 'rte-sep' }),
          el('button', {
            class: 'rte-btn', type: 'button', title: 'Insert link', text: 'Link',
            onmousedown: (e) => e.preventDefault(),
            onclick: () => {
              const href = window.prompt('Link address', 'https://');
              if (!href) return;
              if (!/^https?:\/\//i.test(href) && !/^mailto:/i.test(href)) {
                return toast('Only http, https and mailto links are allowed', 'warn');
              }
              exec('createLink', href);
            }
          }),
          tool('Clear', 'Remove formatting', 'removeFormat')
        ]));
      }

      messageSection.appendChild(bodyEditor);

      if (draft.columns.length) {
        messageSection.appendChild(el('div', { style: { marginTop: '12px' } }, [
          el('span', { class: 'label', text: 'Click to insert' }),
          el('div', { class: 'row row--wrap', style: { marginTop: '8px' } },
            draft.columns.slice(0, 14).map((c) => el('span', { class: 'chip', onclick: () => insertToken(c), text: '{{' + c + '}}' })))
        ]));
      }

      messageSection.appendChild(el('div', { style: { marginTop: '20px' } }, [
        el('span', { class: 'label', style: { display: 'block', marginBottom: '10px' }, text: 'Live preview' }),
        previewBox
      ]));

      renderPreview();
    }

    // ---- 3. attachments ----
    function renderAttachments() {
      attachSection.innerHTML = '';
      attachSection.appendChild(sectionHead('03', 'Attachments', 'Every file here is attached to every recipient.'));

      const list = el('div', { class: 'stack', style: { marginBottom: draft.attachments.length ? '14px' : '0' } },
        draft.attachments.map((a, i) => el('div', { class: 'file-row' }, [
          el('span', { class: 'ext', text: (a.name.split('.').pop() || '?').toUpperCase().slice(0, 4) }),
          el('div', { style: { minWidth: 0, flex: '1' } }, [
            el('div', { class: 'truncate', style: { fontSize: '13px' }, text: a.name }),
            el('p', { class: 'hint', text: fmtBytes(a.size) + (a.url ? ' · stored' : ' · inline') })
          ]),
          el('span', { class: 'pill pill--ok' }, [el('span', { class: 'dot' }), el('span', { text: 'all recipients' })]),
          el('button', {
            class: 'btn btn--ghost btn--icon', 'aria-label': 'Remove', html: '&times;', onclick: async () => {
              if (a.url) api('upload', { action: 'delete', url: a.url }).catch(() => {});
              draft.attachments.splice(i, 1);
              renderAttachments();
              renderLaunch();
            }
          })
        ])));
      attachSection.appendChild(list);

      const zone = el('div', { class: 'dropzone', style: { padding: '24px' } }, [
        el('div', { class: 'big', text: draft.attachments.length ? 'Add another file' : 'Drop the brochure or report here' }),
        el('p', { class: 'hint', text: 'PDF, Word, Excel, PowerPoint, images, CSV or ZIP' })
      ]);
      const input = el('input', { type: 'file', multiple: true, hidden: true, onchange: (e) => uploadFiles(Array.from(e.target.files)) });
      zone.onclick = () => input.click();
      zone.ondragover = (e) => { e.preventDefault(); zone.classList.add('is-over'); };
      zone.ondragleave = () => zone.classList.remove('is-over');
      zone.ondrop = (e) => { e.preventDefault(); zone.classList.remove('is-over'); uploadFiles(Array.from(e.dataTransfer.files)); };
      attachSection.appendChild(zone);
      attachSection.appendChild(input);

      const total = draft.attachments.reduce((s, a) => s + a.size, 0);
      if (total) {
        attachSection.appendChild(el('p', {
          class: 'hint',
          style: { marginTop: '10px', color: total > 8388608 ? 'var(--warn)' : null },
          text: 'Total ' + fmtBytes(total) + ' per email' + (total > 8388608 ? ' — large attachments are more likely to be rejected by strict receivers.' : '')
        }));
      }
    }

    async function uploadFiles(files) {
      for (const file of files) {
        const dismiss = toast('Uploading ' + file.name + '…', 'info', 60000);
        try {
          const data = await api('upload', { name: file.name, type: file.type, data: await fileToBase64(file) });
          draft.attachments.push(data.attachment);
          dismiss();
          toast(file.name + ' attached', 'ok');
          if (data.warning) toast(data.warning, 'warn');
        } catch (err) {
          dismiss();
          toast(err.message, 'err');
        }
      }
      renderAttachments();
      renderLaunch();
    }

    // ---- 4. pacing ----
    function renderPacing() {
      const defaults = (state.settings && state.settings.pacing) || { minDelayMs: 5000, maxDelayMs: 120000, randomize: true, hourlyCap: 60, dailyCap: 400 };
      draft.pacing = draft.pacing || Object.assign({}, defaults);
      const p = draft.pacing;

      pacingSection.innerHTML = '';
      pacingSection.appendChild(sectionHead('04', 'Pacing', 'A human-paced gap between messages. These are your own guard rails — if the provider pushes back, the campaign backs off and tells you why.'));

      const readout = el('p', { class: 'hint' });
      function updateReadout() {
        const perHour = Math.min(p.hourlyCap, Math.floor(3600000 / avgGap(p)));
        readout.textContent = 'About ' + perHour + ' messages per hour at this setting'
          + (draft.rows.length ? ' — roughly ' + fmtDuration(estimateMs(p, draft.rows.length)) + ' for this list.' : '.');
        renderLaunch();
      }

      const mk = (labelText, key, min, max, step, format) => {
        const out = el('span', { class: 'num', style: { fontSize: '13px' } });
        const range = el('input', {
          type: 'range', min, max, step, value: p[key],
          style: { width: '100%', accentColor: '#f4f4f5' },
          oninput: (e) => {
            p[key] = Number(e.target.value);
            if (key === 'minDelayMs' && p.minDelayMs > p.maxDelayMs) p.maxDelayMs = p.minDelayMs;
            if (key === 'maxDelayMs' && p.maxDelayMs < p.minDelayMs) p.minDelayMs = p.maxDelayMs;
            out.textContent = format(p[key]);
            updateReadout();
          }
        });
        out.textContent = format(p[key]);
        return el('div', { class: 'field' }, [
          el('div', { class: 'between' }, [el('label', { class: 'label', text: labelText }), out]),
          range
        ]);
      };

      pacingSection.appendChild(el('div', { class: 'grid grid--2' }, [
        mk('Minimum gap', 'minDelayMs', 5000, 300000, 1000, (v) => fmtDuration(v, true)),
        mk('Maximum gap', 'maxDelayMs', 5000, 600000, 1000, (v) => fmtDuration(v, true))
      ]));

      pacingSection.appendChild(el('div', { class: 'grid grid--2', style: { marginTop: '16px' } }, [
        el('div', { class: 'field' }, [
          el('label', { class: 'label', text: 'Hourly cap' }),
          el('input', { class: 'input num', type: 'number', min: '1', value: p.hourlyCap, oninput: (e) => { p.hourlyCap = Number(e.target.value) || 1; updateReadout(); } })
        ]),
        el('div', { class: 'field' }, [
          el('label', { class: 'label', text: 'Daily cap' }),
          el('input', { class: 'input num', type: 'number', min: '1', value: p.dailyCap, oninput: (e) => { p.dailyCap = Number(e.target.value) || 1; updateReadout(); } })
        ])
      ]));

      pacingSection.appendChild(el('label', { class: 'switch', style: { marginTop: '16px' } }, [
        el('input', { type: 'checkbox', checked: p.randomize, onchange: (e) => { p.randomize = e.target.checked; updateReadout(); } }),
        el('span', { class: 'track' }),
        el('span', { style: { fontSize: '13px' }, text: 'Randomise the gap within the window' })
      ]));

      pacingSection.appendChild(el('div', { style: { marginTop: '12px' } }, [readout]));
      updateReadout();
    }

    // ---- 5. launch ----
    function renderLaunch() {
      launchSection.innerHTML = '';

      const problems = [];
      if (!draft.rows.length) problems.push('Upload a recipient list');
      if (!draft.emailField) problems.push('Choose the email column');
      if (!draft.subject.trim()) problems.push('Write a subject line');
      if (!draft.body.trim()) problems.push('Write the email body');

      const ready = problems.length === 0;
      const p = draft.pacing || {};
      const eta = draft.rows.length ? estimateMs(p, draft.rows.length) : 0;

      launchSection.appendChild(el('div', { class: 'card card--glass card--pad-lg' }, [
        el('div', { class: 'between', style: { flexWrap: 'wrap', gap: '20px' } }, [
          el('div', { style: { minWidth: '260px' } }, [
            el('p', { class: 'eyebrow', text: 'Ready to run' }),
            el('h2', { class: 'h-lg', style: { margin: '8px 0 6px' }, text: draft.name || 'Untitled campaign' }),
            el('p', { class: 'hint', text: ready
              ? fmtNum(draft.rows.length) + ' rows · ' + draft.attachments.length + ' attachment(s) · about ' + fmtDuration(eta) + ' to complete'
              : problems.join(' · ') })
          ]),
          el('button', {
            class: 'btn btn--primary btn--lg', disabled: !ready,
            text: 'Review and start', onclick: createAndReview
          })
        ])
      ]));
    }

    async function createAndReview() {
      const dismiss = toast('Validating recipients…', 'info', 60000);
      try {
        const data = await api('campaign', {
          action: 'create',
          name: draft.name,
          rows: draft.rows,
          columns: draft.columns,
          emailField: draft.emailField,
          subject: draft.subject,
          body: draft.body,
          isHtml: draft.isHtml,
          attachments: draft.attachments,
          pacing: draft.pacing
        });
        dismiss();
        showPreflight(data.campaign, data.preflight);
      } catch (err) {
        dismiss();
        toast(err.message, 'err');
      }
    }
  }

  function sectionHead(number, title, detail) {
    return el('div', { style: { marginBottom: '20px' } }, [
      el('div', { class: 'row', style: { gap: '12px', alignItems: 'baseline' } }, [
        el('span', { class: 'eyebrow', text: number }),
        el('h2', { class: 'h-md', text: title })
      ]),
      detail ? el('p', { class: 'hint', style: { marginTop: '6px', maxWidth: '70ch' }, text: detail }) : null
    ]);
  }

  function miniStat(label, value) {
    return el('div', { style: { padding: '13px 15px', border: '1px solid var(--line)', borderRadius: '12px', background: 'var(--surface-2)' } }, [
      el('span', { class: 'label', text: label }),
      el('div', { class: 'num', style: { fontSize: '22px', letterSpacing: '-0.04em', marginTop: '5px', fontWeight: '300' }, text: value })
    ]);
  }

  /** HTML -> readable plain text, mirroring the server's own conversion. */
  function htmlToText(html) {
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

  /** Plain text -> simple paragraph HTML, preserving blank-line breaks. */
  function textToHtml(text) {
    return String(text)
      .split(/\n{2,}/)
      .map((block) => '<p>' + esc(block).replace(/\n/g, '<br>') + '</p>')
      .join('');
  }

  const avgGap = (p) => Math.max(1, p.randomize ? (p.minDelayMs + p.maxDelayMs) / 2 : p.minDelayMs);

  /** Mirrors estimateDuration on the server: caps only bind on longer lists. */
  function estimateMs(p, count) {
    let ms = count * avgGap(p);
    if (p.hourlyCap && count > p.hourlyCap) ms = Math.max(ms, (count / p.hourlyCap) * 3600000);
    if (p.dailyCap && count > p.dailyCap) ms = Math.max(ms, (count / p.dailyCap) * 86400000);
    return ms;
  }

  function collectTokens(template) {
    const out = [];
    const re = /\{\{\s*([^}|]+?)\s*(?:\|[^}]*)?\}\}/g;
    let m;
    while ((m = re.exec(String(template || '')))) if (!out.includes(m[1].trim())) out.push(m[1].trim());
    return out;
  }

  /** Mirror of the server-side renderer so the preview is faithful. */
  function renderTemplate(template, fields) {
    if (!template) return '';
    const lookup = new Map();
    for (const [k, v] of Object.entries(fields || {})) lookup.set(normKey(k), v);
    return String(template).replace(/\{\{\s*([^}|]+?)\s*(?:\|\s*([^}]*?)\s*)?\}\}/g, (match, token, fallback) => {
      const value = lookup.get(normKey(token));
      if (value != null && String(value).trim() !== '') return String(value).trim();
      return fallback != null ? fallback : '';
    });
  }

  /** Strip script/handler vectors before showing operator-authored HTML. */
  function sanitize(html) {
    const doc = new DOMParser().parseFromString(String(html), 'text/html');
    doc.querySelectorAll('script, iframe, object, embed, link, meta, base').forEach((n) => n.remove());
    doc.querySelectorAll('*').forEach((node) => {
      for (const attr of Array.from(node.attributes)) {
        if (/^on/i.test(attr.name) || (/^(href|src|action)$/i.test(attr.name) && /^\s*javascript:/i.test(attr.value))) {
          node.removeAttribute(attr.name);
        }
      }
    });
    return doc.body.innerHTML;
  }

  // ==========================================================================
  //  PREFLIGHT + LAUNCH
  // ==========================================================================

  function showPreflight(campaign, preflight) {
    const body = el('div', {}, [
      el('div', { class: 'grid grid--2', style: { marginBottom: '18px' } }, [
        miniStat('Valid recipients', fmtNum(campaign.stats.total)),
        miniStat('Excluded', fmtNum(campaign.import.invalid + campaign.import.duplicates + campaign.import.missing + campaign.import.suppressed)),
        miniStat('Attachments', String(campaign.attachments.length)),
        miniStat('Estimated duration', fmtDuration(preflight.estimate.ms))
      ]),

      el('div', { style: { padding: '14px', border: '1px solid var(--line)', borderRadius: '12px', background: 'var(--surface-2)', marginBottom: '18px' } }, [
        infoRow('Sending as', campaign.sender.name ? campaign.sender.name + ' <' + campaign.sender.email + '>' : campaign.sender.email),
        infoRow('Subject', campaign.subject),
        infoRow('Pacing', fmtDuration(campaign.pacing.minDelayMs, true) + ' – ' + fmtDuration(campaign.pacing.maxDelayMs, true) + (campaign.pacing.randomize ? ', randomised' : ', fixed')),
        infoRow('Caps', campaign.pacing.hourlyCap + '/hour · ' + campaign.pacing.dailyCap + '/day')
      ]),

      el('span', { class: 'label', text: 'Preflight' }),
      el('div', { style: { marginTop: '8px' } }, preflight.checks.map((c) => el('div', { class: 'check-row', 'data-level': c.level }, [
        el('span', { class: 'mark', text: c.level === 'pass' ? '✓' : c.level === 'warn' ? '!' : '×' }),
        el('div', { style: { minWidth: 0 } }, [
          el('div', { class: 't', text: c.label }),
          c.detail ? el('div', { class: 'd', text: c.detail }) : null
        ])
      ])))
    ]);

    const close = modal('Start "' + campaign.name + '"?', body, [
      el('button', { class: 'btn', text: 'Not yet', onclick: () => close() }),
      el('button', {
        class: 'btn btn--primary', disabled: !preflight.canStart, text: 'Start campaign',
        onclick: async (e) => {
          e.target.disabled = true;
          e.target.textContent = 'Starting…';
          try {
            await api('campaign', { action: 'control', id: campaign.id, command: 'start' });
            close();
            toast('Campaign started — it now runs on the server', 'ok');
            state.draft = { name: '', rows: [], columns: [], emailField: '', subject: '', body: '', isHtml: true, attachments: [], pacing: null, fileName: '' };
            openCampaign(campaign.id);
          } catch (err) {
            toast(err.message, 'err');
            e.target.disabled = false;
            e.target.textContent = 'Start campaign';
          }
        }
      })
    ]);
  }

  // ==========================================================================
  //  VIEW - MONITOR
  // ==========================================================================

  function openCampaign(id) {
    state.activeCampaignId = id;
    go('monitor');
  }

  async function viewMonitor(root) {
    if (!state.activeCampaignId) {
      const running = state.campaigns.find((c) => c.status === 'running');
      if (running) state.activeCampaignId = running.id;
      else {
        try {
          const list = (await api('campaign', { action: 'list' })).campaigns;
          state.campaigns = list;
          const active = list.find((c) => c.status === 'running') || list[0];
          if (active) state.activeCampaignId = active.id;
        } catch (_) {}
      }
    }

    if (!state.activeCampaignId) {
      root.appendChild(emptyState('Nothing to monitor', 'Start a campaign and this becomes a live view of every send.',
        el('button', { class: 'btn btn--primary', text: 'Build a campaign', onclick: () => go('compose') })));
      return;
    }

    const shell = el('div');
    root.appendChild(shell);
    shell.appendChild(el('div', { class: 'grid grid--4' }, [1, 2, 3, 4].map(() => el('div', { class: 'stat' }, [el('div', { class: 'skeleton', style: { height: '12px', width: '45%' } }), el('div', { class: 'skeleton', style: { height: '30px', marginTop: '16px' } })]))));

    try {
      const data = await api('campaign', { action: 'get', id: state.activeCampaignId });
      state.campaign = data.campaign;
      state.metrics = data.metrics;
      shell.innerHTML = '';
      renderMonitor(shell);
      subscribe(state.activeCampaignId, shell);
    } catch (err) {
      shell.innerHTML = '';
      shell.appendChild(emptyState('Could not load that campaign', err.message));
    }
  }

  function renderMonitor(shell) {
    const c = state.campaign;
    const m = state.metrics;
    shell.innerHTML = '';

    const running = c.status === 'running';
    const sentPct = c.stats.total ? (c.stats.sent / c.stats.total) * 100 : 0;
    const failPct = c.stats.total ? (c.stats.failed / c.stats.total) * 100 : 0;
    const retryPct = c.stats.total ? (c.stats.retrying / c.stats.total) * 100 : 0;

    // Header
    shell.appendChild(el('div', { class: 'between', style: { marginBottom: '22px', flexWrap: 'wrap', gap: '14px' } }, [
      el('div', { style: { minWidth: 0 } }, [
        el('p', { class: 'eyebrow', text: 'Live monitor' }),
        el('h1', { class: 'h-lg', style: { margin: '8px 0 6px' }, text: c.name }),
        el('p', { class: 'hint truncate', text: c.subject })
      ]),
      el('div', { class: 'row row--wrap' }, [
        statePill(c.status),
        running ? el('button', { class: 'btn', text: 'Pause', onclick: () => control('pause') }) : null,
        (c.status === 'paused' || c.status === 'blocked') ? el('button', { class: 'btn btn--primary', text: 'Resume', onclick: () => control('resume') }) : null,
        (running || c.status === 'paused') ? el('button', { class: 'btn btn--danger', text: 'Stop', onclick: async () => {
          if (await confirmDialog('Stop campaign', 'Sending stops immediately. ' + fmtNum(c.stats.sent) + ' messages have already gone out and cannot be recalled.', 'Stop now')) control('stop');
        } }) : null,
        c.stats.failed ? el('button', { class: 'btn', text: 'Retry ' + c.stats.failed + ' failed', onclick: () => control('retry-failed') }) : null
      ])
    ]));

    // Progress panel
    const ring = el('div', { class: 'ring', style: { '--p': String(m.percent) } }, [
      el('div', { class: 'inner' }, [
        el('span', { class: 'pct', text: m.percent.toFixed(0) + '%' }),
        el('span', { class: 'cap', text: 'complete' })
      ])
    ]);

    const countdown = el('span', { class: 'num', style: { fontSize: '34px', letterSpacing: '-0.045em', fontWeight: '300' }, text: '--:--' });

    shell.appendChild(el('div', { class: 'card card--pad-lg', style: { marginBottom: '14px' } }, [
      railParts.rail,
      el('hr', { class: 'divider' }),

      el('div', { class: 'row', style: { gap: '30px', flexWrap: 'wrap', alignItems: 'center' } }, [
        ring,
        el('div', { style: { flex: '1', minWidth: '260px' } }, [
          el('div', { class: 'meter', style: { marginBottom: '14px' } }, [
            el('span', { class: 's-sent', style: { width: sentPct + '%' } }),
            el('span', { class: 's-retry', style: { width: retryPct + '%' } }),
            el('span', { class: 's-failed', style: { width: failPct + '%' } })
          ]),
          el('div', { class: 'row row--wrap', style: { gap: '20px' } }, [
            legend('Sent', c.stats.sent, 'var(--ok)'),
            legend('Retrying', c.stats.retrying, 'var(--warn)'),
            legend('Failed', c.stats.failed, 'var(--err)'),
            legend('Queued', c.stats.queued, 'var(--faint)')
          ])
        ]),
        el('div', { style: { minWidth: '150px' } }, [
          el('span', { class: 'label', text: running ? 'Next send in' : 'Status' }),
          el('div', { style: { marginTop: '8px' } }, [running ? countdown : el('span', { style: { fontSize: '19px' }, text: c.status })]),
          el('p', { class: 'hint', style: { marginTop: '6px' }, text: running && m.nextSendAt ? 'at ' + fmtTime(m.nextSendAt) : (c.completedAt ? 'finished ' + fmtTime(c.completedAt) : '') })
        ])
      ])
    ]));

    // Live countdown, independent of the stream so it stays smooth.
    clearInterval(state.countdownTimer);
    if (running && m.nextSendAt) {
      const target = m.nextSendAt;
      const paint = () => { countdown.textContent = fmtClock(target - Date.now()); };
      paint();
      state.countdownTimer = setInterval(paint, 250);
    }

    // Stat cards
    shell.appendChild(el('div', { class: 'grid grid--4', style: { marginBottom: '14px' } }, [
      statCard('Sent', fmtNum(c.stats.sent), '/ ' + fmtNum(c.stats.total), [el('span', { text: fmtNum(m.remaining) + ' remaining' })]),
      statCard('Rate', fmtNum(m.ratePerHour), '/hr', [el('span', { text: m.avgIntervalMs ? 'avg gap ' + fmtDuration(m.avgIntervalMs, true) : 'measuring…' })]),
      statCard('Elapsed', fmtDuration(m.elapsedMs, true), null, [el('span', { text: c.startedAt ? 'since ' + fmtTime(c.startedAt) : 'not started' })]),
      statCard('Remaining', m.etaMs != null ? fmtDuration(m.etaMs, true) : '--', null, [el('span', { text: 'estimated' })])
    ]));

    if (m.caps && m.caps.blocked) {
      shell.appendChild(el('div', { class: 'card', style: { marginBottom: '14px', borderColor: 'rgba(230,201,141,0.3)', background: 'var(--warn-dim)' } }, [
        el('div', { class: 'row' }, [
          el('span', { class: 'pill pill--warn' }, [el('span', { class: 'dot' }), el('span', { text: m.caps.scope + ' cap' })]),
          el('span', { class: 'hint', text: 'Sending is paused until ' + fmtTime(m.caps.resumeAt) + ' to stay inside your configured limit.' })
        ])
      ]));
    }

    // Recipients + activity
    const recipientsPanel = el('div', { class: 'card', style: { padding: '0', overflow: 'hidden' } });
    const activityPanel = el('div', { class: 'card' }, [
      el('div', { class: 'between', style: { marginBottom: '12px' } }, [
        el('span', { class: 'label', text: 'Activity' }),
        running ? el('span', { class: 'pill pill--ok pill--live' }, [el('span', { class: 'dot' }), el('span', { text: 'live' })]) : null
      ]),
      el('div', { class: 'feed' }, (c.events || []).slice(0, 60).map(feedRow))
    ]);

    shell.appendChild(el('div', { class: 'grid grid--sidebar' }, [recipientsPanel, activityPanel]));
    renderRecipientsPanel(recipientsPanel);
  }

  function legend(label, value, color) {
    return el('div', { class: 'row', style: { gap: '7px' } }, [
      el('span', { style: { width: '6px', height: '6px', borderRadius: '50%', background: color, flex: 'none' } }),
      el('span', { class: 'hint', text: label }),
      el('span', { class: 'num', style: { fontSize: '13px' }, text: fmtNum(value) })
    ]);
  }

  function feedRow(ev) {
    return el('div', { class: 'feed-row', 'data-type': ev.type }, [
      el('span', { class: 't', text: fmtTime(ev.t) }),
      el('span', { class: 'icon' }),
      el('div', { class: 'body' }, [
        el('div', { class: 'msg', text: ev.message }),
        ev.detail ? el('div', { class: 'det', text: ev.detail }) : null
      ])
    ]);
  }

  async function renderRecipientsPanel(panel) {
    let filter = 'all';
    let search = '';
    let offset = 0;

    const head = el('div', { class: 'between', style: { padding: '18px 20px', borderBottom: '1px solid var(--line)', flexWrap: 'wrap', gap: '10px' } });
    const bodyWrap = el('div');
    panel.innerHTML = '';
    panel.appendChild(head);
    panel.appendChild(bodyWrap);

    const searchInput = el('input', {
      class: 'input', placeholder: 'Search recipients…', style: { width: '200px', height: '30px', padding: '0 11px', fontSize: '12.5px' },
      oninput: debounce((e) => { search = e.target.value; offset = 0; load(); }, 300)
    });

    head.appendChild(el('span', { class: 'label', text: 'Recipients' }));
    head.appendChild(el('div', { class: 'row row--wrap' }, [
      el('div', { class: 'tabs' }, ['all', 'sent', 'queued', 'retrying', 'failed'].map((f) => el('button', {
        class: 'tab' + (f === filter ? ' is-active' : ''),
        text: f[0].toUpperCase() + f.slice(1),
        onclick: (e) => {
          filter = f; offset = 0;
          $$('.tab', head).forEach((t) => t.classList.remove('is-active'));
          e.target.classList.add('is-active');
          load();
        }
      }))),
      searchInput
    ]));

    async function load() {
      bodyWrap.innerHTML = '';
      bodyWrap.appendChild(el('div', { style: { padding: '20px' } }, [el('div', { class: 'skeleton', style: { height: '160px' } })]));
      try {
        const data = await api('campaign', { action: 'recipients', id: state.activeCampaignId, offset, limit: 200, filter, search });
        bodyWrap.innerHTML = '';
        if (!data.recipients.length) {
          bodyWrap.appendChild(emptyState('Nothing here', filter === 'all' ? 'This campaign has no recipients in range.' : 'No recipients with status "' + filter + '".'));
          return;
        }
        bodyWrap.appendChild(el('div', { class: 'table-scroll' }, [
          el('table', { class: 'data' }, [
            el('thead', {}, [el('tr', {}, [
              el('th', { text: 'Recipient' }),
              el('th', { text: 'Personalised' }),
              el('th', { text: 'State' }),
              el('th', { class: 'num', text: 'Tries' }),
              el('th', { text: 'Time' })
            ])]),
            el('tbody', {}, data.recipients.map((r) => {
              const fieldCount = Object.keys(r.fields || {}).filter((k) => String(r.fields[k] || '').trim() !== '').length;
              return el('tr', { title: r.lastError || '' }, [
                el('td', {}, [
                  el('div', { class: 'truncate', style: { maxWidth: '240px' }, text: r.email }),
                  r.lastError ? el('div', { class: 'hint truncate', style: { maxWidth: '240px', color: 'var(--err)' }, text: r.lastError }) : null
                ]),
                el('td', { class: 'hint', text: fieldCount + ' field' + (fieldCount === 1 ? '' : 's') }),
                el('td', {}, [el('span', { class: 'state state--' + r.status }, [el('span', { class: 'dot' }), el('span', { text: r.status })])]),
                el('td', { class: 'num hint', text: String(r.attempts || 0) }),
                el('td', { class: 'hint', text: r.sentAt ? fmtTime(r.sentAt) : (r.nextAttemptAt ? 'retry ' + fmtTime(r.nextAttemptAt) : '—') })
              ]);
            }))
          ])
        ]));

        if (data.total > 200) {
          bodyWrap.appendChild(el('div', { class: 'between', style: { padding: '12px 20px', borderTop: '1px solid var(--line)' } }, [
            el('span', { class: 'hint', text: 'Showing ' + (offset + 1) + '–' + Math.min(offset + 200, data.total) + ' of ' + fmtNum(data.total) }),
            el('div', { class: 'row' }, [
              el('button', { class: 'btn btn--sm', disabled: offset === 0, text: 'Previous', onclick: () => { offset = Math.max(0, offset - 200); load(); } }),
              el('button', { class: 'btn btn--sm', disabled: offset + 200 >= data.total, text: 'Next', onclick: () => { offset += 200; load(); } })
            ])
          ]));
        }
      } catch (err) {
        bodyWrap.innerHTML = '';
        bodyWrap.appendChild(el('p', { class: 'hint hint--err', style: { padding: '20px' }, text: err.message }));
      }
    }

    load();
  }

  async function control(command) {
    try {
      const data = await api('campaign', { action: 'control', id: state.activeCampaignId, command });
      state.campaign = data.campaign;
      toast('Campaign ' + (command === 'retry-failed' ? 'retrying failed recipients' : command + 'd'), 'ok');
      go('monitor');
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  // ---- SSE subscription ----

  function subscribe(id, shell) {
    unsubscribe();
    if (!window.EventSource) return pollFallback(id, shell);

    const source = new EventSource('/api/stream?id=' + encodeURIComponent(id));
    state.stream = source;

    let repaintPending = false;
    const repaint = () => {
      if (repaintPending) return;
      repaintPending = true;
      requestAnimationFrame(() => {
        repaintPending = false;
        if (state.route === 'monitor' && shell.isConnected) renderMonitor(shell);
        updateChrome();
      });
    };

    source.addEventListener('state', (e) => {
      const data = JSON.parse(e.data);
      state.campaign = data.campaign;
      state.metrics = data.metrics;
      repaint();
    });

    source.addEventListener('tick', (e) => {
      const data = JSON.parse(e.data);
      if (state.metrics) state.metrics = data.metrics;
    });

    source.addEventListener('final', (e) => {
      const data = JSON.parse(e.data);
      state.campaign = data.campaign;
      state.metrics = data.metrics;
      repaint();
      toast('Campaign ' + data.campaign.status, data.campaign.status === 'completed' ? 'ok' : 'warn');
      source.close();
      state.stream = null;
    });

    source.addEventListener('notice', (e) => {
      const data = JSON.parse(e.data);
      if (data.message) toast(data.message, 'warn');
    });

    // EventSource reconnects on its own; nothing to do but let it.
    source.onerror = () => {};
  }

  function pollFallback(id, shell) {
    const timer = setInterval(async () => {
      if (state.route !== 'monitor' || !shell.isConnected) return clearInterval(timer);
      try {
        const data = await api('campaign', { action: 'get', id });
        state.campaign = data.campaign;
        state.metrics = data.metrics;
        renderMonitor(shell);
      } catch (_) {}
    }, 4000);
    state.stream = { close: () => clearInterval(timer) };
  }

  function unsubscribe() {
    if (state.stream) { try { state.stream.close(); } catch (_) {} state.stream = null; }
    clearInterval(state.countdownTimer);
  }

  // ==========================================================================
  //  VIEW - CAMPAIGNS
  // ==========================================================================

  async function viewCampaigns(root) {
    root.appendChild(el('div', { class: 'hero' }, [
      el('p', { class: 'eyebrow', text: 'History' }),
      el('h1', { class: 'h-lg', style: { margin: '10px 0' }, text: 'Campaigns' }),
      el('p', { class: 'lede', text: 'Every campaign, with the exact transport result for each recipient.' })
    ]));

    const wrap = el('div');
    root.appendChild(wrap);
    wrap.appendChild(el('div', { class: 'skeleton', style: { height: '220px' } }));

    try {
      const campaigns = (await api('campaign', { action: 'list' })).campaigns;
      state.campaigns = campaigns;
      wrap.innerHTML = '';

      if (!campaigns.length) {
        wrap.appendChild(emptyState('No campaigns yet', 'Your first campaign will appear here with a full per-recipient record.',
          el('button', { class: 'btn btn--primary', text: 'Build a campaign', onclick: () => go('compose') })));
        return;
      }

      let filter = 'all';
      const search = el('input', { class: 'input', placeholder: 'Search by name or subject…', style: { maxWidth: '280px', height: '34px' } });
      const table = el('div');

      const paint = () => {
        const q = search.value.trim().toLowerCase();
        const list = campaigns.filter((c) =>
          (filter === 'all' || c.status === filter) &&
          (!q || c.name.toLowerCase().includes(q) || String(c.subject || '').toLowerCase().includes(q)));
        table.innerHTML = '';
        table.appendChild(list.length ? campaignTable(list) : emptyState('No matches', 'Try a different filter or search term.'));
      };

      search.oninput = debounce(paint, 220);

      wrap.appendChild(el('div', { class: 'between', style: { marginBottom: '14px', flexWrap: 'wrap', gap: '10px' } }, [
        el('div', { class: 'tabs' }, ['all', 'running', 'completed', 'paused', 'stopped'].map((f) => el('button', {
          class: 'tab' + (f === filter ? ' is-active' : ''),
          text: f[0].toUpperCase() + f.slice(1),
          onclick: (e) => { filter = f; $$('.tab', wrap).forEach((t) => t.classList.remove('is-active')); e.target.classList.add('is-active'); paint(); }
        }))),
        search
      ]));
      wrap.appendChild(table);
      paint();
    } catch (err) {
      wrap.innerHTML = '';
      wrap.appendChild(el('p', { class: 'hint hint--err', text: err.message }));
    }
  }

  // ==========================================================================
  //  VIEW - SETTINGS
  // ==========================================================================

  async function viewSettings(root) {
    root.appendChild(el('div', { class: 'hero' }, [
      el('p', { class: 'eyebrow', text: 'Configuration' }),
      el('h1', { class: 'h-lg', style: { margin: '10px 0' }, text: 'Settings' }),
      el('p', { class: 'lede', text: 'Defaults applied to every new campaign. Existing campaigns keep the policy they started with.' })
    ]));

    const wrap = el('div');
    root.appendChild(wrap);

    let data;
    try { data = await api('settings', { action: 'get' }); }
    catch (err) { wrap.appendChild(el('p', { class: 'hint hint--err', text: err.message })); return; }

    state.settings = data.settings;
    const s = JSON.parse(JSON.stringify(data.settings));

    const num = (label, value, onInput, hint) => el('div', { class: 'field' }, [
      el('label', { class: 'label', text: label }),
      el('input', { class: 'input num', type: 'number', min: '1', value: String(value), oninput: (e) => onInput(Number(e.target.value)) }),
      hint ? el('p', { class: 'hint', text: hint }) : null
    ]);

    wrap.appendChild(el('div', { class: 'grid grid--2' }, [
      el('div', { class: 'card card--pad-lg' }, [
        el('span', { class: 'label', text: 'Pacing defaults' }),
        el('div', { class: 'grid grid--2', style: { marginTop: '16px' } }, [
          num('Minimum gap (seconds)', s.pacing.minDelayMs / 1000, (v) => { s.pacing.minDelayMs = v * 1000; }),
          num('Maximum gap (seconds)', s.pacing.maxDelayMs / 1000, (v) => { s.pacing.maxDelayMs = v * 1000; })
        ]),
        el('div', { class: 'grid grid--2', style: { marginTop: '14px' } }, [
          num('Hourly cap', s.pacing.hourlyCap, (v) => { s.pacing.hourlyCap = v; }),
          num('Daily cap', s.pacing.dailyCap, (v) => { s.pacing.dailyCap = v; })
        ]),
        el('label', { class: 'switch', style: { marginTop: '16px' } }, [
          el('input', { type: 'checkbox', checked: s.pacing.randomize, onchange: (e) => { s.pacing.randomize = e.target.checked; } }),
          el('span', { class: 'track' }),
          el('span', { style: { fontSize: '13px' }, text: 'Randomise gaps by default' })
        ])
      ]),

      el('div', { class: 'card card--pad-lg' }, [
        el('span', { class: 'label', text: 'Retry policy' }),
        el('div', { class: 'grid grid--2', style: { marginTop: '16px' } }, [
          num('Max attempts', s.retry.maxAttempts, (v) => { s.retry.maxAttempts = v; }, 'Per recipient, including the first try'),
          num('Base backoff (seconds)', s.retry.baseBackoffMs / 1000, (v) => { s.retry.baseBackoffMs = v * 1000; }, 'Doubles with each attempt')
        ]),
        el('hr', { class: 'divider' }),
        el('span', { class: 'label', text: 'Data' }),
        el('div', { style: { marginTop: '14px' } }, [
          num('Retention (days)', s.retentionDays, (v) => { s.retentionDays = v; }, 'How long campaign records are kept')
        ])
      ])
    ]));

    wrap.appendChild(el('div', { class: 'card card--pad-lg', style: { marginTop: '14px' } }, [
      el('span', { class: 'label', text: 'Default template' }),
      el('div', { class: 'field', style: { marginTop: '14px' } }, [
        el('label', { class: 'label', text: 'Subject' }),
        el('input', { class: 'input', value: s.defaultSubject || '', oninput: (e) => { s.defaultSubject = e.target.value; } })
      ]),
      el('div', { class: 'field', style: { marginTop: '12px' } }, [
        el('label', { class: 'label', text: 'Body' }),
        el('textarea', { class: 'textarea textarea--code', rows: '7', oninput: (e) => { s.defaultBody = e.target.value; } }, [s.defaultBody || ''])
      ])
    ]));

    wrap.appendChild(el('div', { class: 'card card--pad-lg', style: { marginTop: '14px' } }, [
      el('div', { class: 'between' }, [
        el('div', {}, [
          el('span', { class: 'label', text: 'Suppression list' }),
          el('p', { class: 'hint', style: { marginTop: '6px' }, text: fmtNum(data.suppression) + ' addresses are excluded from every campaign.' })
        ]),
        el('button', { class: 'btn btn--sm', text: 'Add addresses', onclick: showSuppressionDialog })
      ])
    ]));

    wrap.appendChild(el('div', { class: 'row', style: { marginTop: '18px' } }, [
      el('button', {
        class: 'btn btn--primary', text: 'Save settings', onclick: async (e) => {
          e.target.disabled = true;
          try {
            const saved = await api('settings', Object.assign({ action: 'save' }, s));
            state.settings = saved.settings;
            toast('Settings saved', 'ok');
          } catch (err) { toast(err.message, 'err'); }
          e.target.disabled = false;
        }
      })
    ]));
  }

  function showSuppressionDialog() {
    const area = el('textarea', { class: 'textarea textarea--code', rows: '8', placeholder: 'one@example.com\ntwo@example.com' });
    const close = modal('Add to suppression list', el('div', {}, [
      el('p', { class: 'hint', style: { marginBottom: '12px' }, text: 'These addresses will be skipped by every future campaign. One per line.' }),
      area
    ]), [
      el('button', { class: 'btn', text: 'Cancel', onclick: () => close() }),
      el('button', {
        class: 'btn btn--primary', text: 'Add', onclick: async () => {
          const emails = area.value.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
          if (!emails.length) return close();
          try {
            const res = await api('settings', { action: 'suppression-add', emails });
            toast(res.suppressed + ' addresses suppressed', 'ok');
            close();
            render();
          } catch (err) { toast(err.message, 'err'); }
        }
      })
    ]);
  }

  // ==========================================================================
  //  ROUTER + CHROME
  // ==========================================================================

  const ROUTES = {
    dashboard: { title: 'Dashboard', render: viewDashboard },
    compose: { title: 'Compose', render: viewCompose },
    monitor: { title: 'Monitor', render: viewMonitor },
    campaigns: { title: 'Campaigns', render: viewCampaigns },
    connection: { title: 'Connection', render: viewConnection },
    settings: { title: 'Settings', render: viewSettings }
  };

  function go(route) {
    if (!ROUTES[route]) route = 'dashboard';
    state.route = route;
    if (location.hash !== '#' + route) history.replaceState(null, '', '#' + route);
    render();
  }

  function render() {
    unsubscribe();
    if (demo.running) demoPause();      // the rehearsal only runs while it is on screen
    demoStop();
    const root = $('#view');
    root.innerHTML = '';
    $$('.nav-item[data-route]').forEach((n) => n.classList.toggle('is-active', n.dataset.route === state.route));
    $('#topbar-title').textContent = ROUTES[state.route].title;
    $('#nav').classList.remove('is-open');
    $('.nav-scrim') && $('.nav-scrim').remove();
    updateChrome();
    window.scrollTo(0, 0);

    Promise.resolve(ROUTES[state.route].render(root)).catch((err) => {
      if (err && err.message === 'Session expired') return;
      root.appendChild(el('p', { class: 'hint hint--err', text: err.message }));
      console.error(err);
    });
  }

  function updateChrome() {
    const pill = $('#conn-pill');
    const info = connectionPill(state.connection);
    pill.hidden = false;
    pill.className = 'pill ' + info.cls;
    $('.txt', pill).textContent = info.text;
    $('#btn-recheck').hidden = !state.connection;

    const live = state.campaigns.some((c) => c.status === 'running') || (state.campaign && state.campaign.status === 'running');
    $('#nav-live').hidden = !live;

    const meta = $('#footer-meta');
    if (meta) {
      const bits = ['Kech v1.0.0'];
      if (state.sessionExpiresAt) bits.push('session until ' + fmtTime(state.sessionExpiresAt));
      meta.textContent = bits.join('  ·  ');
    }
  }

  // ---- heartbeat: revive a worker chain that died while nobody was watching --
  let heartbeat = null;
  function startHeartbeat() {
    clearInterval(heartbeat);
    heartbeat = setInterval(() => {
      if (document.hidden) return;
      fetch('/api/tick?sweep=1', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{"sweep":true}' }).catch(() => {});
    }, 120000);
  }

  // ==========================================================================
  //  BOOT
  // ==========================================================================

  function showGate(message) {
    unsubscribe();
    clearInterval(heartbeat);
    $('#app').hidden = true;
    $('#gate').hidden = false;
    if (message) {
      const box = $('#gate-error');
      box.hidden = false;
      box.textContent = message;
    }
    setTimeout(() => $('#gate-code').focus(), 60);
  }

  async function enterConsole() {
    $('#gate').hidden = true;
    $('#app').hidden = false;

    try {
      const [conn, settings, list] = await Promise.all([
        api('connection', { action: 'get' }),
        api('settings', { action: 'get' }),
        api('campaign', { action: 'list' })
      ]);
      state.connection = conn.connection;
      state.settings = settings.settings;
      state.campaigns = list.campaigns;
    } catch (err) {
      if (err.message === 'Session expired') return;
      toast(err.message, 'err');
    }

    startHeartbeat();
    go((location.hash || '#dashboard').slice(1));
  }

  $('#gate-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = $('#gate-submit');
    const errorBox = $('#gate-error');
    errorBox.hidden = true;
    button.disabled = true;
    button.textContent = 'Checking…';

    try {
      const result = await api('auth', { action: 'login', code: $('#gate-code').value });
      state.sessionExpiresAt = result.expiresAt;
      $('#gate-code').value = '';
      await enterConsole();
    } catch (err) {
      errorBox.hidden = false;
      errorBox.textContent = err.message;
      $('#gate-code').select();
    } finally {
      button.disabled = false;
      button.textContent = 'Enter console';
    }
  });

  $('#sign-out').addEventListener('click', async () => {
    await api('auth', { action: 'logout' }).catch(() => {});
    state.connection = null;
    state.campaigns = [];
    showGate('Signed out.');
  });

  $('#btn-recheck').addEventListener('click', recheckConnection);

  $('#nav-toggle').addEventListener('click', () => {
    const nav = $('#nav');
    nav.classList.add('is-open');
    const scrim = el('div', { class: 'nav-scrim', onclick: () => { nav.classList.remove('is-open'); scrim.remove(); } });
    document.body.appendChild(scrim);
  });

  $$('.nav-item[data-route]').forEach((node) => {
    node.addEventListener('click', () => go(node.dataset.route));
  });

  window.addEventListener('hashchange', () => {
    const route = (location.hash || '#dashboard').slice(1);
    if (route !== state.route && !$('#app').hidden) go(route);
  });

  // Resume the session if the cookie is still valid.
  (async function boot() {
    try {
      const session = await api('auth', { action: 'session' });
      if (session.authenticated) {
        state.sessionExpiresAt = session.expiresAt;
        return enterConsole();
      }
    } catch (_) {}
    showGate();
  })();

  window.showGate = showGate;
})();
