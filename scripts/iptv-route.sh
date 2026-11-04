#!/bin/sh
# /jffs/scripts/iptv-route.sh
# ------------------------------------------------------------------
# IPTV + Internet dual-access for Asuswrt-Merlin (JFFS persistence)
#
# Topology (verified on RT-AC68U / Merlin 386.14_2):
#   ONT LAN1 ---- Asus WAN (eth0)   <- carries BOTH PPPoE internet and IPTV
#   ONT LAN4 ---- Asus LAN4         <- [DEPRECATED] redundant loop cable that
#                                      leaks the ONT DHCP server into the LAN.
#
# Principle:
#   The ONT is a layer-3 device. Its management address (IPTV_GW) is also the
#   next hop toward the IPTV networks. Routing those two prefixes at the ONT
#   is all that is required for LAN clients to reach IPTV while keeping
#   normal internet access through PPPoE.
#
# Why no NAT (measured):
#   Return traffic arrives as src=<IPTV host> dst=<Asus WAN address>, and the
#   ONT routes it back correctly. The router is doing layer-3 forwarding, not
#   layer-2 bridging, so MASQUERADE is unnecessary. Adding it only complicates
#   conntrack. The only requirement is net.ipv4.ip_forward=1 (Merlin default).
#
# Why 10.8.0.0/13 instead of 10.12.0.0/13:
#   A /13 requires the third octet to be a multiple of 8. 10.12.0.0/13 is
#   invalid and the kernel silently returns "Invalid argument".
#   10.8.0.0/13 covers 10.8 - 10.15.x, which includes 10.12.x.
#
# Idempotent: safe to run repeatedly.
# Rollback:  remove this file and its callers in /jffs/scripts/, then reboot.
# ------------------------------------------------------------------

# ---------- configuration ----------
# Override via /jffs/configs/iptv-route.conf if your LAN differs.
IPTV_GW="${IPTV_GW:-192.168.2.1}"    # ONT management address = IPTV next hop
WAN_IF="${WAN_IF:-eth0}"             # Asus WAN interface
LAN_NET="${LAN_NET:-192.168.50.0/24}"  # LAN subnet (informational)

NET_A="${NET_A:-10.8.0.0/13}"        # covers 10.8 - 10.15.x (includes 10.12.x)
NET_B="${NET_B:-10.248.0.0/13}"      # covers 10.248 - 10.255.x

CONF="/jffs/configs/iptv-route.conf"
[ -f "$CONF" ] && . "$CONF"

log() { logger -t iptv-route "$*"; echo "[iptv-route] $*"; }

# ---------- wait for WAN ----------
# eth0 must have an address inside the ONT subnet before routes make sense.
GW_PREFIX=$(echo "$IPTV_GW" | sed 's/\.[0-9]*$//')
i=0
while [ $i -lt 30 ]; do
  if ip -4 addr show dev "$WAN_IF" 2>/dev/null | grep -q "inet ${GW_PREFIX}\."; then
    break
  fi
  i=$((i + 1))
  sleep 2
done

# Then confirm the gateway actually answers (the ONT may boot slower).
i=0
while [ $i -lt 15 ]; do
  if ping -c 1 -W 1 "$IPTV_GW" >/dev/null 2>&1; then
    break
  fi
  i=$((i + 1))
  sleep 2
done

# ---------- 1) IP forwarding ----------
if [ "$(cat /proc/sys/net/ipv4/ip_forward 2>/dev/null)" != "1" ]; then
  echo 1 > /proc/sys/net/ipv4/ip_forward && log "ip_forward enabled"
fi

# ---------- 2) routes: IPTV networks via the ONT ----------
add_route() {
  net="$1"
  if ip route show | grep -qF "$net via $IPTV_GW dev $WAN_IF"; then
    log "route already present: $net"
  else
    ip route del "$net" 2>/dev/null   # drop stale entries from an old gateway
    if ip route add "$net" via "$IPTV_GW" dev "$WAN_IF"; then
      log "route added: $net via $IPTV_GW"
    else
      log "ERROR: route add failed: $net"
    fi
  fi
}

add_route "$NET_A"
add_route "$NET_B"

# ---------- 3) no NAT (intentionally empty) ----------
# Measured: the ONT handles return routing, MASQUERADE is not needed.
# If a future ONT/bridge-mode change breaks return traffic, enable:
#
#   iptables -t nat -I POSTROUTING -s "$LAN_NET" -d "$NET_A" -o "$WAN_IF" -j MASQUERADE
#   iptables -t nat -I POSTROUTING -s "$LAN_NET" -d "$NET_B" -o "$WAN_IF" -j MASQUERADE

# ---------- 4) DHCP guard ----------
# Defence in depth: drop DHCP server replies arriving from the WAN side so LAN
# clients can never lease an address from the ONT by mistake.
# Idempotent by flushing same-shape rules first (the -C test is unreliable
# because MAC matching is case-sensitive).
ONT_MAC=""
for mac in $(ip neigh show dev "$WAN_IF" 2>/dev/null | awk -v gw="$IPTV_GW" '$1 == gw {print $3}'); do
  ONT_MAC="$mac"
done

if [ -n "$ONT_MAC" ]; then
  iptables -S INPUT 2>/dev/null | grep -F -- "-i $WAN_IF -p udp -m udp --sport 67 --dport 68" | grep -F -- "-j DROP" | \
    sed 's/^-A /-D /' | while read -r rule; do
      iptables $rule 2>/dev/null
    done
  iptables -I INPUT -i "$WAN_IF" -p udp --sport 67 --dport 68 -m mac --mac-source "$ONT_MAC" -j DROP 2>/dev/null \
    && log "DHCP guard ensured for ONT mac $ONT_MAC"
fi

log "done"
