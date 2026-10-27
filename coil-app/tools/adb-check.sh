#!/bin/bash
# Read-only health check for coil machines: is it running, reporting, and can it
# take an OTA update? Changes nothing on the machine. One or more addresses:
#
#   bash coil-app/tools/adb-check.sh 100.104.211.77:5555 100.74.205.17:5555
#
# Machine keys are masked in anything printed from the logs.
A=~/Library/Android/sdk/platform-tools/adb
PKG=isl.snudursopi.vending.debug
[ $# -eq 0 ] && { echo "usage: bash $0 IP:PORT [IP:PORT ...]"; exit 1; }
mask() { sed -E 's/mk_live_[A-Za-z0-9_-]+/mk_live_***/g'; }
ok()  { printf '  ✓ %s\n' "$1"; }
bad() { printf '  ✗ %s\n' "$1"; }

for D in "$@"; do
  echo "=== $D"
  $A connect "$D" | grep -q "connected" || { bad "adb cannot connect"; continue; }
  s() { $A -s "$D" shell "$@" | tr -d '\r'; }

  # BSD grep on a Mac has no -P, so everything below is plain grep/sed.
  year=$(s date +%Y)
  [ -n "$year" ] && [ "$year" -ge 2026 ] 2>/dev/null && ok "clock: $(s date)" || bad "clock WRONG: $(s date) — TLS will fail"
  [ "$(s settings get global auto_time)" = 1 ] && ok "automatic time on" || bad "automatic time OFF"
  [ "$(s getprop persist.adb.tcp.port)" = 5555 ] && ok "adb port pinned to 5555" || bad "adb port not pinned"

  pkgdump=$(s dumpsys package $PKG)
  ver=$(printf '%s\n' "$pkgdump" | sed -n 's/.*versionName=\([^ ]*\).*/\1/p' | head -1)
  vc=$(printf '%s\n' "$pkgdump" | sed -n 's/.*versionCode=\([0-9]*\).*/\1/p' | head -1)
  [ -n "$ver" ] && ok "app $ver ($vc)" || { bad "$PKG not installed"; continue; }
  printf '%s\n' "$pkgdump" | grep -q "WRITE_SECURE_SETTINGS: granted=true" \
    && ok "clock grant held (app re-enables automatic time itself)" || bad "WRITE_SECURE_SETTINGS not granted"
  s pidof $PKG >/dev/null && ok "app running" || bad "app NOT running"
  s dumpsys activity activities | grep -m1 -E "mResumedActivity|topResumedActivity" | grep -q "$PKG" \
    && ok "app is on screen" || bad "something else is on screen: $(s dumpsys activity activities | grep -m1 -E 'mResumedActivity|topResumedActivity' | grep -o '{[^}]*}')"

  owner=$(s dumpsys device_policy | grep -i -A3 "device owner" | grep -o 'ComponentInfo{[^}]*}' | head -1)
  if echo "$owner" | grep -q "$PKG"; then ok "Device Owner — OTA installs silently"
  else bad "not Device Owner (${owner:-none}) — OTA will see updates but REFUSE to install"; fi

  echo "  recent app log (newest last):"
  logs=$(s logcat -d -v time -s VendingViewModel:I ProxyClient:I AppUpdater:I ClockGuard:I SalesRepository:I | mask)
  printf '%s\n' "$logs" | grep -E "Consolidated to|paired:|WebSocket open|WebSocket fail|manifest target|update failed|automatic time|command poll failed|Catalog load failed" | tail -12 | sed 's/^/    /'
  printf '%s\n' "$logs" | grep -q "Consolidated to"   && ok "catalog loaded from Weimi"      || bad "no catalog load in the log"
  printf '%s\n' "$logs" | grep -q "WebSocket open"    && ok "proxy connected to the backend" || bad "no proxy connection in the log"
  if printf '%s\n' "$logs" | grep -q "manifest target"; then ok "update check reached the backend with its key"
  else echo "  · no update check yet — the first runs an hour after the app starts (or Diagnostics → leita að uppfærslu)"; fi
done
