#!/bin/bash
# A new fridge over adb, in two runs. Safe to repeat: a dropped connection costs a re-run.
#
#   bash fridge-app/tools/fridge-setup.sh IP:PORT            # step 1: everything but Device Owner
#   bash fridge-app/tools/fridge-setup.sh IP:PORT --owner    # step 2: after pairing and the PIN test
#   bash fridge-app/tools/fridge-setup.sh IP:PORT --baskets  # any time: which baskets answer
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
[ -z "$D" ] && { echo "usage: bash $0 IP:PORT [--owner|--baskets]"; exit 1; }
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
    # Android starts an always-on VPN at boot; without it Tailscale stays down after a restart
    # (8626020606). The app sets it itself from fridge 0.70.6, as Device Owner or with the grant.
    [ "$(s settings get secure always_on_vpn_app)" = com.tailscale.ipn ] \
      && ok "Tailscale is the always-on VPN" || bad "Tailscale is not the always-on VPN — it will not come back after a restart"
  else
    bad "Tailscale not installed"
  fi
  local o; o=$(owner)
  [ -n "$o" ] && ok "Device Owner: $o" || echo "  ·  not Device Owner yet"
  for p in com.weimi.monitor com.weimi.gs_vendor; do
    s dumpsys package $p | grep -q "hidden=true" && ok "$p hidden" || echo "  ·  $p not hidden"
  done
}

# The app holds the scale port, so adb cannot read the baskets itself. Instead: wait for a
# read_all_trays issued from the dashboard and read its answer from the app's log. Tray numbers
# are the board's: cabinet A from 0 (A1 = 0), cabinet B from 20 (B1 = 20), 10 or 16 per cabinet.
if [ "$MODE" = "--baskets" ]; then
  SINCE=$(s date +'%m-%d %H:%M:%S.000')
  echo "Dashboard → this machine → read_all_trays, now. Waiting up to 90 s…"
  LINE=""
  for _ in $(seq 1 30); do
    # One string: adb joins its arguments with spaces, so an unquoted time arrives as two words.
    LINE=$(s "logcat -d -T '$SINCE' -s CommandRunner:I" | grep "command read_all_trays" | tail -1)
    [ -n "$LINE" ] && break
    sleep 3
  done
  [ -z "$LINE" ] && { echo "no read_all_trays answer in 90 s — is the machine paired and online?"; exit 1; }
  echo "$LINE" | grep -q -- "-> ok" || { echo "read_all_trays did not succeed:"; echo "  ${LINE#*: }"; exit 1; }
  echo "$LINE" | awk '
    function label(t) { return (t >= 20 ? "B" (t - 19) : "A" (t + 1)) }
    {
      match($0, /expecting [0-9]+ trays, got [0-9]+/); split(substr($0, RSTART, RLENGTH), h, " ")
      want = h[2]; got = h[5]
      n = split($0, f, " ")
      for (i = 1; i <= n; i++) if (f[i] ~ /^#[0-9]+=-?[0-9]+g$/) {
        split(substr(f[i], 2), kv, "="); w[kv[1] + 0] = kv[2]
      }
      printf "== baskets: %d of %d answering\n", got, want
      # 10 or 16 per cabinet; a double (20 or 32) has two cabinets, the second addressed from 20.
      per = (want == 20 || want == 32) ? want / 2 : want
      for (k = 0; k < want; k++) {
        t = (k < per) ? k : 20 + (k - per)
        if (t in w) {
          g = w[t] + 0; note = (g <= -20) ? "  ⚠ negative — tare it empty" : ""
          printf "  ✅ %-4s #%-2d %7s%s\n", label(t), t, w[t], note
        } else printf "  ❌ %-4s #%-2d  silent — check its cable / module\n", label(t), t
        delete w[t]
      }
      for (t in w) printf "  ?  #%s=%s answered but is not expected for this cabinet layout\n", t, w[t]
    }'
  FAULTS=$(s logcat -d -t 2000 | grep "SENSOR FAULT" | tail -5)
  [ -n "$FAULTS" ] && { echo "recent sensor faults in the log:"; echo "$FAULTS" | sed 's/^/  /'; }
  exit 0
fi

if [ "$MODE" = "--owner" ]; then
  if [ -n "$(owner)" ]; then
    echo "Device Owner already set. Bringing the app forward so it applies its policies…"
    s am start -n $PKG/isl.snudursopi.fridge.MainActivity >/dev/null; sleep 10; report; exit 0
  fi
  [ -z "$(s pidof $PKG)" ] && { echo "our app is not running — run step 1 first"; exit 1; }
  echo "Device Owner cannot be removed from outside the app."
  read -r -p "Has the escape hatch been tested ON THIS MACHINE (long-press clock → PIN → admin)? [yes/no] " a
  [ "$a" = "yes" ] || { echo "Not set. Test the hatch first."; exit 1; }
  s dpm set-device-owner $ADMIN
  # The app applies its Device Owner policies (hide Weimi, lock task, home) when it comes to the
  # front. It already was, so bring it forward again: singleTask, so this pauses and resumes it.
  s am start -n $PKG/isl.snudursopi.fridge.MainActivity >/dev/null
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

# Tailscale as the always-on VPN, so it comes back after a restart. Never over another VPN.
if s pm list packages | grep -q com.tailscale.ipn; then
  case "$(s settings get secure always_on_vpn_app)" in
    null|""|com.tailscale.ipn) s settings put secure always_on_vpn_app com.tailscale.ipn
                               s settings put secure always_on_vpn_lockdown 0 ;;
  esac
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
  3. Settings → Developer options → Wireless debugging, on THIS Wi-Fi: tick
     "Always allow on this network". Without it Android switches wireless debugging
     off again within minutes, and dashboard "adb on" never gets a port (8626020606).
  4. Then: bash $0 $D --owner
  5. After tare/calibration: bash $0 $D --baskets
NEXT
