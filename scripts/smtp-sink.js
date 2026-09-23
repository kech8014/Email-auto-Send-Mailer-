'use strict';

const net = require('net');

/**
 * A throwaway SMTP server used only by the end-to-end test. It accepts AUTH
 * LOGIN, records every delivered message, and can be told to fail specific
 * recipients so retry and permanent-failure paths are exercised for real.
 */
function createSink(options) {
  const opts = options || {};
  const received = [];
  const failures = opts.failures || {}; // { 'a@b.com': { code: 550, text: '...' } }
  let transientHits = {};

  const server = net.createServer((socket) => {
    let buffer = '';
    let state = { from: null, rcpt: [], inData: false, data: '', authStage: null };
    const write = (line) => socket.write(line + '\r\n');

    write('220 sink.test ESMTP ready');

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let idx;
      while ((idx = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);

        if (state.inData) {
          if (line === '.') {
            state.inData = false;
            const rcpt = state.rcpt[0];
            received.push({ from: state.from, to: state.rcpt.slice(), raw: state.data, at: Date.now() });
            state.data = '';
            state.rcpt = [];
            write('250 2.0.0 Ok: queued as ' + Math.random().toString(36).slice(2));
          } else {
            state.data += line + '\n';
          }
          continue;
        }

        if (state.authStage === 'user') { state.authStage = 'pass'; write('334 UGFzc3dvcmQ6'); continue; }
        if (state.authStage === 'pass') { state.authStage = null; write('235 2.7.0 Authentication successful'); continue; }

        const upper = line.toUpperCase();
        if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
          write('250-sink.test');
          write('250-AUTH LOGIN PLAIN');
          write('250-SIZE 52428800');
          write('250 8BITMIME');
        } else if (upper.startsWith('AUTH LOGIN')) {
          state.authStage = 'user';
          write('334 VXNlcm5hbWU6');
        } else if (upper.startsWith('AUTH PLAIN')) {
          write('235 2.7.0 Authentication successful');
        } else if (upper.startsWith('MAIL FROM')) {
          state.from = (line.match(/<([^>]*)>/) || [])[1] || null;
          write('250 2.1.0 Ok');
        } else if (upper.startsWith('RCPT TO')) {
          const addr = ((line.match(/<([^>]*)>/) || [])[1] || '').toLowerCase();
          const rule = failures[addr];
          if (rule) {
            if (rule.transientTimes) {
              transientHits[addr] = (transientHits[addr] || 0) + 1;
              if (transientHits[addr] <= rule.transientTimes) {
                write(rule.code + ' ' + rule.text);
                continue;
              }
            } else {
              write(rule.code + ' ' + rule.text);
              continue;
            }
          }
          state.rcpt.push(addr);
          write('250 2.1.5 Ok');
        } else if (upper === 'DATA') {
          state.inData = true;
          write('354 End data with <CR><LF>.<CR><LF>');
        } else if (upper === 'QUIT') {
          write('221 2.0.0 Bye');
          socket.end();
        } else if (upper === 'RSET') {
          state.from = null; state.rcpt = []; write('250 2.0.0 Ok');
        } else {
          write('250 2.0.0 Ok');
        }
      }
    });

    socket.on('error', () => {});
  });

  return {
    server,
    received,
    listen(port) {
      return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server.address().port)));
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    }
  };
}

module.exports = { createSink };
