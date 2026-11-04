# iptv-merlin-jffs

Keep **IPTV and regular internet working at the same time**, and make it
**survive a reboot**, on an ASUS router running Asuswrt-Merlin.

The setup is two routes and one firewall rule, installed by a script in
`/jffs/scripts/`. No NAT, no extra hardware, no changes to the ONT.

---

## The problem

A Chinese ISP delivers IPTV on a dedicated layer-3 network that is only
reachable through the ONT (optical network terminal). If you put the ONT into
bridge mode so your own router can do PPPoE and full-cone NAT, the TV loses the
path to IPTV, because that path ran through the ONT's own routing and DHCP.

The usual workaround is to punch routes and NAT rules on the router by hand.
That works until the next reboot, when everything disappears.

---

## How it works

The ONT is a **layer-3 device**. Even in bridge mode for internet traffic, its
management address is still a valid next hop toward the IPTV networks.

```
                    ┌──────────────────────────────┐
                    │  ONT  (e.g. 192.168.2.1)     │
                    │   ├─ internet  (bridged/PPPoE)
                    │   └─ IPTV network (layer 3)  │
                    └───────────┬──────────────────┘
                                │ single cable
                    ┌───────────▼──────────────────┐
                    │  ASUS router (Merlin)        │
                    │  WAN  eth0   = 192.168.2.x   │
                    │  LAN  br0    = 192.168.50.1  │
                    │                              │
                    │  route 10.8.0.0/13   ──► ONT │
                    │  route 10.248.0.0/13 ──► ONT │
                    └───────────┬──────────────────┘
                                │
                      TV / clients on the LAN
                      internet + IPTV together ✅
```

Two routes are all that is needed:

```sh
ip route add 10.8.0.0/13   via 192.168.2.1 dev eth0
ip route add 10.248.0.0/13 via 192.168.2.1 dev eth0
```

### Why there is no NAT

Return traffic for an IPTV session looks like this in `nf_conntrack`:

```
src=192.168.50.223 dst=10.254.192.83 ... src=10.254.192.83 dst=192.168.2.5
                                                   ^^^^^^^^^^^^^^^^
                                                   router's WAN address
```

The ONT routes that back to the router's WAN address on its own, because the
router is performing layer-3 forwarding rather than layer-2 bridging. So
`MASQUERADE` is not required. Adding it is not just unnecessary, it makes the
conntrack table harder to reason about.

The only prerequisite is `net.ipv4.ip_forward=1`, which Merlin already sets.

### Why `/13` and not `/12` or a narrower prefix

A `/13` requires the third octet to be a multiple of 8. `10.12.0.0/13` is a
**malformed** prefix: the kernel rejects it with `RTNETLINK answers: Invalid
argument` and, depending on the tool, may fail silently. Use a prefix whose
network address is aligned:

| prefix | covers | valid? |
|---|---|---|
| `10.12.0.0/13` | — | ❌ not aligned, silently rejected |
| `10.8.0.0/13` | 10.8 – 10.15.x (includes 10.12.x) | ✅ |
| `10.248.0.0/13` | 10.248 – 10.255.x (includes 10.253/10.254.x) | ✅ |

---

## Install

### 1. Prerequisites

- ASUS router flashed with **Asuswrt-Merlin** (this was developed on
  `RT-AC68U`, firmware `386.14_2`).
- SSH access enabled: **Administration → System → Enable SSH = LAN only**,
  plus *Allow password login*. **Reboot once** for `dropbear` to actually start.
- The ONT reachable from the router's WAN interface.

### 2. Enable JFFS custom scripts

**Administration → System**

- `Enable JFFS custom scripts and configs` = **Yes**
- Apply.

Verify over SSH:

```sh
nvram get jffs2_on       # 1
nvram get jffs2_scripts  # 1
mount | grep /jffs       # /dev/mtdblockN on /jffs type jffs2 (rw,noatime)
```

> The JFFS partition must be mounted. Formatting requires a reboot and may take
> two reboots to take effect.

### 3. Copy the scripts

The scripts must live in `/jffs/scripts/`, be **executable**, and have **UNIX
line endings** — a CRLF shebang makes them fail silently.

The reliable way to move files onto Asuswrt is HTTP, because its busybox SSH
has no SFTP subsystem, no `base64`, and truncates long commands and heredocs.

On your PC, from this repository:

```sh
npm install                                # installs ssh2
node tools/lan-files.js 8899               # serves this directory on :8899
```

Then over SSH on the router:

```sh
mkdir -p /jffs/scripts
cd /jffs/scripts
curl -s -O http://<your-pc-ip>:8899/scripts/iptv-route.sh
curl -s -O http://<your-pc-ip>:8899/scripts/services-start
curl -s -O http://<your-pc-ip>:8899/scripts/firewall-start
chmod a+rx /jffs/scripts/iptv-route.sh \
           /jffs/scripts/services-start \
           /jffs/scripts/firewall-start
ls -l /jffs/scripts/          # all three must show -rwx
```

### 4. Adjust the gateway address

The script defaults to `IPTV_GW=192.168.2.1`. If your ONT uses another address,
create an override file instead of editing the script:

```sh
cat > /jffs/configs/iptv-route.conf <<'EOF'
IPTV_GW=192.168.2.1
WAN_IF=eth0
NET_A=10.8.0.0/13
NET_B=10.248.0.0/13
EOF
```

### 5. Run it and verify

```sh
/jffs/scripts/iptv-route.sh
ip route | grep -E '10\.(8|248)'
ping -c 3 10.12.240.1
```

From a LAN client, confirm **both** work:

```sh
ping -c 3 10.12.240.1   # IPTV
ping -c 3 223.5.5.5     # internet
```

### 6. Prove it survives a reboot

This is the whole point — do not skip it.

```sh
reboot
```

After it comes back:

```sh
ip route | grep -E '10\.(8|248)'
iptables -S INPUT | grep 'sport 67' | grep -c DROP   # expect 1
ping -c 3 10.12.240.1
```

Or run the bundled checker:

```sh
ASUS_USER=admin ASUS_PASS=secret node tools/verify-state.js
```

---

## Scripts

| file | installed to | purpose |
|---|---|---|
| `scripts/iptv-route.sh` | `/jffs/scripts/iptv-route.sh` | the actual work: waits for WAN, adds routes, installs the DHCP guard. Idempotent. |
| `scripts/services-start` | `/jffs/scripts/services-start` | boot hook, runs the main script in the background |
| `scripts/firewall-start` | `/jffs/scripts/firewall-start` | re-applies after firewall restart / PPPoE redial |

Merlin calls `services-start` once at boot and `firewall-start` whenever the
firewall is rebuilt. Both call the same idempotent script, so a redial can
never leave you without the guard.

### Idempotency

`iptv-route.sh` can be run any number of times:

- routes are checked with an exact `ip route show` match before adding
- the DHCP guard is **flushed and re-added** rather than appended, because
  `iptables -C` cannot reliably match when MAC casing differs

Verified by running it three times in a row: routes stay at 2, the guard stays
at 1.

---

## Troubleshooting

### LAN clients get an address in the ONT's subnet

Symptom: a client receives e.g. `192.168.2.101` instead of an address from
your router's LAN subnet (`192.168.50.x`).

Cause is almost always a **second cable between the ONT and the router**,
usually plugged into a LAN port. That bridges the ONT's DHCP server straight
into your LAN.

Check the switch topology:

```sh
robocfg show                   # look for a port whose MAC is the ONT
robocfg showmacs | grep -i <ont-mac>
brctl showmacs br0 | grep -i <ont-mac>     # if present on br0, you have a leak
```

Fix: unplug the redundant cable. IPTV does **not** need it — it goes over the
WAN link. Verify with the port down:

```sh
robocfg port 4 state disabled
ping -c 3 10.12.240.1          # should still work
robocfg port 4 state enabled
```

The script also installs a DHCP guard that drops DHCP replies arriving from the
WAN side, as defence in depth.

### `ip route add` says "Invalid argument"

The prefix is not aligned for its mask length. See the `/13` table above.

### Scripts do not run at boot

Check, in order:

```sh
nvram get jffs2_scripts        # must be 1
ls -l /jffs/scripts/           # must be executable
head -1 /jffs/scripts/iptv-route.sh   # must be #!/bin/sh, no CRLF
```

Then look for log output:

```sh
logger -t iptv-route "manual marker"
/jffs/scripts/iptv-route.sh
logread | grep iptv-route
```

### SSH refuses connections although `sshd_enable=2`

Setting the nvram value is not enough, and `restart_sshd` is **not** a valid
Merlin 386 action name. Enable SSH in the Web UI and **reboot the router** —
`dropbear` starts during boot.

---

## Tools

| script | purpose |
|---|---|
| `tools/asus-ssh.js` | run commands over SSH; reads `ASUS_HOST`/`ASUS_USER`/`ASUS_PASS` |
| `tools/lan-files.js` | HTTP file server for PC ↔ router transfer (`GET` / `PUT`) |
| `tools/verify-state.js` | health check: routes, guard, IPTV, internet |

All credentials come from the environment. Nothing is hardcoded.

```sh
export ASUS_USER=admin
export ASUS_PASS=secret
export ASUS_HOST=192.168.50.1
node tools/verify-state.js
```

---

## Rollback

```sh
# stop persisting
rm /jffs/scripts/iptv-route.sh \
   /jffs/scripts/services-start \
   /jffs/scripts/firewall-start

# clear the runtime state (or just reboot, since nothing re-applies it now)
ip route del 10.8.0.0/13
ip route del 10.248.0.0/13
iptables -D INPUT -i eth0 -p udp --sport 67 --dport 68 -m mac --mac-source <ont-mac> -j DROP
```

Reverting the firmware itself is a normal flash from the vendor image.

---

## Scope and caveats

- **Tested on one router, one ISP, one ONT** (`RT-AC68U` / Merlin `386.14_2`).
  The *approach* is general, but the addresses, interfaces and prefix lengths
  are site-specific — re-measure them for your installation.
- `multicast_snooping` and IGMP proxy settings are **not** handled here. On the
  hardware tested they made no difference to IPTV playback; if your deployment
  needs multicast, that is a separate problem.
- The DHCP guard depends on learning the ONT's MAC at runtime. If the ONT is
  not reachable when the script runs, no guard is installed for that boot.
- Firmware updates may relocate or change hooks. Re-verify after upgrading.

---

## License

MIT
