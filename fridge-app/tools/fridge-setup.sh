#!/bin/bash
# A new fridge over adb, in two runs. Safe to repeat: a dropped connection costs a re-run.
#
#   bash fridge-app/tools/fridge-setup.sh IP:PORT            # step 1: everything but Device Owner
#   bash fridge-app/tools/fridge-setup.sh IP:PORT --owner    # step 2: after pairing and the PIN test
#
# Step 1 sets automatic time, pins adb to port 5555, installs the published fridge build from the
# backend, grants WRITE_SECURE_SETTINGS (dashboard "adb on" and the clock guard), stops the Weimi
# apps that hold the serial ports and starts our app. Pairing stays on the screen: issue a code in
# the dashboard and type it on the kiosk. Never prints or sends the machine key.
#
# Step 2 sets Device Owner, which cannot be undone from outside the app, so it asks first whether
# the admin escape hatch (long-press the clock → PIN) has been tested on this machine.
#
# APK: downloaded once per run from the backend (the release published in Fleet → Releases).
# Use a local file instead with APK=/path/to/app.apk bash fridge-app/tools/fridge-setup.sh IP:PORT
D="$1"; MODE="$2"
A=~/Library/Android/sdk/platform-tools/adb
PKG=isl.snudursopi.fridge.debug
ADMIN=$PKG/isl.snudursopi.fridge.KioskAdminReceiver
APK_URL=https://api.agvending.is/api/v1/app-release/fridge/apk
[ -z "$D" ] && { echo "usage: bash $0 IP:PORT [--owner]"; exit 1; }
$A connect "$D" | grep -q "connected" || { echo "could not connect to $D"; exit 1; }
s() { $A -s "$D" shell "$@" | tr -d '\r'; }
ok()   { echo "  ✅ $*"; }
bad()  { echo "  ❌ $*"; }

owner() { s dumpsys device_policy | grep -i -A3 "device owner" | grep -o 'ComponentInfo{[^}]*}' | head -1; }
# Tailscale's range is 100.64.0.0/10. Not tied to an interface name: it is not always tun0.
tailscale_ip() {
  s ip -4 addr 2>/dev/null | grep -oE 'inet 100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9.]+' | head -1 | cut -d' ' -f2
}

report() {
  echo "== $D · $(s date)"
  [ "$(s settings get global auto_time)" = 1 ] && ok "automatic time on" || bad "automatic time OFF"
  [ "$(s getprop persist.adb.tcp.port)" = 5555 ] && ok "adb pinned to 5555" || bad "adb port not pinned"
  local vn; vn=$(s dumpsys package $PKG | grep -m1 versionName | sed 's/.*versionName=//')
  [ -n "$vn" ] && ok "app $vn" || bad "app not installed"
  s dumpsys package $PKG | grep -q "WRITE_SECURE_SETTINGS: granted=true" \
    && ok "WRITE_SECURE_SETTINGS granted (dashboard adb on works)" || bad "WRITE_SECURE_SETTINGS not granted"
  [ -n "$(s pidof $PKG)" ] && ok "app running" || bad "app not running"
  if s pm list packages | grep -q com.tailscale.ipn; then
    local ip; ip=$(tailscale_ip)
    # Reached over a Tailscale address: it is up, whatever the interface list says.
    [ -z "$ip" ] && case "${D%%:*}" in 100.*) ip="${D%%:*} (reached over it)";; esac
    [ -n "$ip" ] && ok "Tailscale up: $ip" || bad "Tailscale installed but not connected"
  else
    bad "Tailscale not installed"
  fi
  local o; o=$(owner)
  [ -n "$o" ] && ok "Device Owner: $o" || echo "  ·  not Device Owner yet"
  for p in com.weimi.monitor com.weimi.gs_vendor; do
    s dumpsys package $p | grep -q "hidden=true" && ok "$p hidden" || echo "  ·  $p not hidden"
  done
}

if [ "$MODE" = "--owner" ]; then
  [ -n "$(owner)" ] && { echo "Device Owner already set."; report; exit 0; }
  [ -z "$(s pidof $PKG)" ] && { echo "our app is not running — run step 1 first"; exit 1; }
  echo "Device Owner cannot be removed from outside the app."
  read -r -p "Has the escape hatch been tested ON THIS MACHINE (long-press clock → PIN → admin)? [yes/no] " a
  [ "$a" = "yes" ] || { echo "Not set. Test the hatch first."; exit 1; }
  s dpm set-device-owner $ADMIN
  echo "waiting 15 s for the app to hide the Weimi apps and become home…"
  sleep 15
  report
  exit 0
fi

echo "== before: $(s date) · auto_time=$(s settings get global auto_time) · $(s getprop ro.product.model) Android $(s getprop ro.build.version.release)"

# A wrong clock fails every TLS call while the screen looks healthy (62160479, 2026-10-24).
s settings put global auto_time 1
# Keep adb on a fixed port across reboots, so the next session needs no one at the screen.
s setprop persist.adb.tcp.port 5555

INSTALLED=$(s pm list packages | grep -i snudursopi)
echo "installed: ${INSTALLED:-none}"
if echo "$INSTALLED" | grep -qx "package:isl.snudursopi.fridge"; then
  echo "NOT INSTALLING: a non-debug package is present (different signature). Send this output on."
else
  if [ -z "$APK" ]; then
    APK="$(mktemp -d)/fridge.apk"
    echo "downloading the published fridge build…"
    curl -fsSL -o "$APK" "$APK_URL" || { echo "download failed: $APK_URL"; exit 1; }
  fi
  head -c 2 "$APK" | grep -q PK || { echo "$APK is not an APK"; exit 1; }
  $A -s "$D" install -r "$APK" || { echo "install failed — send this output on"; exit 1; }
  s pm grant $PKG android.permission.WRITE_SECURE_SETTINGS
fi

# The Weimi apps hold the serial ports (scales, card reader). Monitor first: it restarts the others.
# com.weimi.launcher is left alone — the board needs it until our app is Device Owner and home.
s am force-stop com.weimi.monitor
s am force-stop com.weimi.gs_vendor

s monkey -p $PKG -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
sleep 8
report
cat <<NEXT

Next, at the machine:
  1. Dashboard → issue a pairing code → type it on the kiosk.
  2. Test the escape hatch: long-press the clock → PIN → admin opens.
  3. Then: bash $0 $D --owner
NEXT
