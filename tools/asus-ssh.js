#!/usr/bin/env node
// asus-ssh.js — run commands on an Asuswrt router over SSH.
//
// Credentials come from the environment; nothing is hardcoded:
//   ASUS_HOST  (default 192.168.50.1)
//   ASUS_USER  (required)
//   ASUS_PASS  (required)
//
// Usage:
//   ASUS_USER=admin ASUS_PASS=secret node asus-ssh.js "nvram get firmver" "ip route"

const { Client } = require('ssh2');

const HOST = process.env.ASUS_HOST || '192.168.50.1';
const USER = process.env.ASUS_USER;
const PASS = process.env.ASUS_PASS;

if (!USER || !PASS) {
  console.error('ERROR: set ASUS_USER and ASUS_PASS environment variables.');
  process.exit(2);
}

function run(cmds, { timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let out = '';
    let settled = false;
    const done = (err, val) => {
      if (settled) return;
      settled = true;
      try { conn.end(); } catch {}
      err ? reject(err) : resolve(val);
    };
    conn.on('ready', () => {
      let i = 0;
      const next = () => {
        if (i >= cmds.length) return done(null, out);
        const cmd = cmds[i++];
        conn.exec(cmd, (err, stream) => {
          if (err) return done(err);
          let buf = '';
          stream.on('data', (d) => { buf += d.toString('utf8'); });
          stream.stderr.on('data', (d) => { buf += d.toString('utf8'); });
          stream.on('close', () => {
            out += '\n$ ' + cmd + '\n' + buf;
            next();
          });
        });
      };
      next();
    });
    conn.on('error', (e) => done(e));
    conn.on('keyboard-interactive', (n, i2, l, p, cb) => cb([PASS]));
    conn.connect({
      host: HOST, port: 22, username: USER, password: PASS,
      tryKeyboard: true, readyTimeout: timeout,
      algorithms: {
        kex: [
          'curve25519-sha256',
          'curve25519-sha256@libssh.org',
          'ecdh-sha2-nistp256',
          'diffie-hellman-group14-sha256',
          'diffie-hellman-group14-sha1',
        ],
      },
    });
  });
}

module.exports = { run, HOST, USER, PASS };

if (require.main === module) {
  const cmds = process.argv.slice(2);
  if (!cmds.length) {
    console.error('usage: node asus-ssh.js "command1" "command2" ...');
    process.exit(2);
  }
  run(cmds)
    .then((o) => { console.log(o); process.exit(0); })
    .catch((e) => { console.error('ERR', e.message); process.exit(1); });
}
