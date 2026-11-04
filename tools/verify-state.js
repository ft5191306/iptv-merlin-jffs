#!/usr/bin/env node
// verify-state.js — one-shot health check for the IPTV dual-access setup.
//
// Confirms that routes, the DHCP guard, IPTV reachability and internet access
// are all in place. Run it after a reboot to prove persistence actually works.
//
// Config via environment:
//   ASUS_HOST   (default 192.168.50.1)
//   ASUS_USER   (required)
//   ASUS_PASS   (required)
//   IPTV_GW     (default 192.168.2.1)   ONT management address
//   IPTV_TEST   (default 10.12.240.1)   an IPTV host to ping
//   NET_A / NET_B (default 10.8.0.0/13, 10.248.0.0/13)
//
// Usage: ASUS_USER=admin ASUS_PASS=secret node verify-state.js

const { run } = require('./asus-ssh');

const IPTV_GW = process.env.IPTV_GW || '192.168.2.1';
const IPTV_TEST = process.env.IPTV_TEST || '10.12.240.1';
const NET_A = process.env.NET_A || '10.8.0.0/13';
const NET_B = process.env.NET_B || '10.248.0.0/13';
const WAN_IF = process.env.WAN_IF || 'eth0';

const checks = [
  ['firmware', 'nvram get firmver; nvram get buildno; nvram get extendno'],
  ['jffs enabled', 'nvram get jffs2_on; nvram get jffs2_scripts'],
  ['scripts present', 'ls -la /jffs/scripts/'],
  ['routes', 'ip route | grep -E "10\\.(8|248)"'],
  ['dhcp guard count (expect 1)',
    'iptables -S INPUT | grep "sport 67" | grep -c DROP'],
  ['ont gateway reachable', `ping -c 2 -W 2 ${IPTV_GW} | tail -2`],
  ['iptv reachable', `ping -c 3 -W 2 ${IPTV_TEST} | tail -2`],
  ['internet reachable', 'ping -c 2 -W 2 223.5.5.5 | tail -2'],
  ['default route', 'ip route show default'],
  ['wan interface address', `ip -4 addr show dev ${WAN_IF}`],
];

(async () => {
  let ok = true;
  for (const [label, cmd] of checks) {
    let out;
    try {
      out = await run([cmd], { timeout: 60000 });
    } catch (e) {
      console.log(`\n=== ${label} ===\nERROR: ${e.message}`);
      ok = false;
      continue;
    }
    const body = out.replace(/^\n\$ [\s\S]*?\n/, '').trim();
    console.log(`\n=== ${label} ===\n${body}`);
  }

  // Explicit assertions for the two things that must survive a reboot.
  console.log('\n=== VERDICT ===');
  try {
    const routes = await run(['ip route'], { timeout: 30000 });
    const hasA = routes.includes(NET_A);
    const hasB = routes.includes(NET_B);
    console.log(`route ${NET_A}: ${hasA ? 'OK' : 'MISSING'}`);
    console.log(`route ${NET_B}: ${hasB ? 'OK' : 'MISSING'}`);
    if (!hasA || !hasB) ok = false;

    const ping = await run([`ping -c 2 -W 2 ${IPTV_TEST} | tail -1`], { timeout: 30000 });
    const iptvOk = !/100% packet loss/.test(ping);
    console.log(`IPTV (${IPTV_TEST}): ${iptvOk ? 'OK' : 'UNREACHABLE'}`);
    if (!iptvOk) ok = false;
  } catch (e) {
    console.log('ERROR during verdict:', e.message);
    ok = false;
  }

  console.log(ok ? '\nRESULT: ALL CHECKS PASSED' : '\nRESULT: PROBLEMS FOUND');
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
