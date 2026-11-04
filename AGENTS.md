# AGENTS.md

Orientation for an agent working in this repository: what the files are, how to
change them safely, and what breaks silently.

## What this is

JFFS scripts plus a few Node tools that keep IPTV and normal internet working
together on an ASUS router running Asuswrt-Merlin, and keep them working across
reboots.

`README.md` is for humans installing it. This file is what you need before
editing anything.

## Layout

| path | role |
|---|---|
| `scripts/iptv-route.sh` | the actual work: routes + DHCP guard. Runs at boot and on firewall restart. Idempotent. |
| `scripts/services-start` | boot hook, calls the main script in the background |
| `scripts/firewall-start` | firewall-restart hook, calls the same script |
| `tools/asus-ssh.js` | SSH executor, credentials from env |
| `tools/lan-files.js` | HTTP file server for PC ↔ router copies |
| `tools/verify-state.js` | health check, exits non-zero when something is wrong |
| `README.md` | install and troubleshooting guide for humans |

## The three invariants

Break any of these and the scripts fail **silently** — no error message, no
obvious symptom, just rules that never appear after a reboot.

1. **UNIX line endings.** A CRLF shebang makes `/bin/sh` refuse the file with a
   message that goes nowhere useful. Verify after every edit:

   ```sh
   head -1 scripts/iptv-route.sh    # must be exactly: #!/bin/sh
   ```

   If your editor rewrites them, set `* text=auto eol=lf` in `.gitattributes`
   or convert before committing. Check a file's bytes, not its appearance in an
   editor — many editors display both identically.

2. **Executable bit.** Merlin skips a non-executable hook without a word.
   `git` tracks the bit, so commit the mode change explicitly:

   ```sh
   chmod a+rx scripts/iptv-route.sh scripts/services-start scripts/firewall-start
   git add --chmod=+x scripts/
   ```

3. **Correct hook filenames.** Merlin calls `services-start` and
   `firewall-start` by exact name, in `/jffs/scripts/`. A typo means the file
   simply never runs. When adding a hook, confirm Merlin supports that name
   before relying on it.

## Changing the script

`scripts/iptv-route.sh` runs unattended at boot. Assume no interactivity, no
`/jffs` writes beyond config, and a filesystem that may still be settling.

**Idempotency is mandatory.** Both hooks call it, sometimes within seconds of
each other, and `firewall-start` fires again on every PPPoE redial.

- Check before adding a route (`ip route show | grep -qF`), don't append blindly.
- For iptables, **flush the rule shape then add**, rather than testing with
  `-C`. `-C` does not reliably match when MAC address casing differs between
  the rule and the query.
- Follow the existing `add_route` / DHCP-guard pattern rather than inventing a
  second approach.

**Keep the no-NAT decision.** The routes alone are sufficient because the ONT
routes return traffic back to the router's WAN address. Adding `MASQUERADE` is
not a harmless extra — it changes conntrack behaviour and hides the real
routing relationship. If you believe NAT is needed, first produce `nf_conntrack`
evidence for a session that fails without it.

**Site-specific values stay configurable.** The ONT address, interface and
prefixes are defaults, overridable through `/jffs/configs/iptv-route.conf`. Do
not hardcode a particular installation's addresses into logic.

### Prefix arithmetic

An IPv4 prefix must be aligned for its mask length. A `/13` needs the third
octet to be a multiple of 8.

| prefix | valid | notes |
|---|---|---|
| `10.12.0.0/13` | ❌ | not aligned; kernel returns `Invalid argument`, often swallowed |
| `10.8.0.0/13` | ✅ | 10.8 – 10.15.x, covers `10.12.x` |
| `10.248.0.0/13` | ✅ | 10.248 – 10.255.x, covers `10.253.x` / `10.254.x` |

Adding a route for a narrower host-specific range is fine when you know the
exact host; guessing a misaligned prefix is not.

## Deploying a change

The router's busybox SSH has no SFTP subsystem, no `base64`, and truncates long
commands and heredocs. Copy files over HTTP:

```sh
# on the PC, from the repo root
node tools/lan-files.js 8899

# over SSH on the router
cd /jffs/scripts
curl -s -O http://<pc-ip>:8899/scripts/iptv-route.sh
chmod a+rx iptv-route.sh
```

Never assemble a script on the router from `echo`/`printf` fragments. Truncation
is silent and produces a file that looks plausible and fails at boot.

## Verifying

Two levels, and the second is the one that matters:

```sh
# 1) does it work right now
/jffs/scripts/iptv-route.sh
ip route | grep -E '10\.(8|248)'

# 2) does it survive a reboot  <- the actual requirement
reboot
# after it returns:
ASUS_USER=... ASUS_PASS=... node tools/verify-state.js
```

`tools/verify-state.js` exits non-zero on missing routes or unreachable IPTV.
Treat a green run after a reboot as the definition of done; a green run before
one proves almost nothing.

Run the script three times in a row and confirm route count stays 2 and the
DHCP guard count stays 1 — that is the idempotency check.

## Credentials

Nothing is hardcoded. `tools/asus-ssh.js` reads:

| variable | meaning |
|---|---|
| `ASUS_HOST` | router address, default `192.168.50.1` |
| `ASUS_USER` | SSH username, required |
| `ASUS_PASS` | SSH password, required |
| `IPTV_GW` | ONT address, default `192.168.2.1` |
| `IPTV_TEST` | host to ping as the IPTV check |

Keep it that way. If you need a new secret, read it from the environment; do not
write it into a file that can be committed. Never paste real addresses,
passwords or ISP account details into docs, examples, commit messages or issues.

## Symptoms and causes

| symptom | cause |
|---|---|
| clients lease an address in the ONT's subnet | second cable between ONT and router on a LAN port, bridging the ONT's DHCP into the LAN |
| `ip route add` → `Invalid argument` | misaligned prefix, see the table above |
| routes gone after reboot | `jffs2_scripts=0`, missing exec bit, or CRLF line endings |
| DHCP guard count is 2+ | rule added instead of flushed; see idempotency |
| SSH refuses connections though `sshd_enable=2` | `dropbear` not started; enable in the Web UI and reboot. `restart_sshd` is not a valid Merlin 386 action |

## Scope

One router, one ISP, one ONT were measured — `RT-AC68U`, Merlin `386.14_2`. The
approach generalises; the addresses, interfaces and prefix lengths do not.
Re-measure before applying to another site, and re-verify after any firmware
upgrade, since hooks may move.

Multicast handling (IGMP proxy, snooping) is deliberately out of scope: on the
hardware tested it did not affect IPTV playback, and it is a separate problem
when it does.
