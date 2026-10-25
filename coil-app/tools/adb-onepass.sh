#!/bin/bash
# Everything a coil machine needs over adb, in one pass — so a short adb window is
# enough and a dropped connection costs a re-run, not a lost step. Safe to repeat.
#
#   bash coil-app/tools/adb-onepass.sh IP:PORT
#
# Never prints or sends the machine key. Pairing is left to the screen: issue a
# code in the dashboard and type it on the kiosk.
D="$1"
A=~/Library/Android/sdk/platform-tools/adb
APK="$(cd "$(dirname "$0")/.." && pwd)/app/build/outputs/apk/debug/app-debug.apk"
PKG_DEBUG=isl.snudursopi.vending.debug
[ -z "$D" ] && { echo "usage: bash $0 IP:PORT"; exit 1; }
[ -f "$APK" ] || { echo "no APK at $APK — run ./gradlew assembleDebug in coil-app first"; exit 1; }
$A connect "$D" | grep -q "connected" || { echo "could not connect to $D"; exit 1; }
s() { $A -s "$D" shell "$@" | tr -d '\r'; }

echo "== before: $(s date) · auto_time=$(s settings get global auto_time)"

# A wrong clock fails every TLS call while the screen looks healthy (62160479, 2026-10-24).
s settings put global auto_time 1
# Keep adb on a fixed port across reboots, so the next session needs no one at the screen.
s setprop persist.adb.tcp.port 5555
echo "adb port pinned: $(s getprop persist.adb.tcp.port)"

INSTALLED=$(s pm list packages | grep -i snudursopi)
echo "installed: ${INSTALLED:-none}"
if echo "$INSTALLED" | grep -qx 'package:isl.snudursopi.vending'; then
  echo "NOT INSTALLING: a non-debug package is present — a different signature. Send this output on."
else
  $A -s "$D" install -r "$APK"
  # From 0.80.0 the app switches automatic time back on at every start by itself,
  # Device Owner or not, once it holds this grant. It survives app updates.
  s pm grant $PKG_DEBUG android.permission.WRITE_SECURE_SETTINGS && echo "WRITE_SECURE_SETTINGS granted"
  s monkey -p $PKG_DEBUG -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
  echo "version: $(s dumpsys package $PKG_DEBUG | grep -m1 versionName)"
fi

sleep 10
echo "== after: $(s date) · auto_time=$(s settings get global auto_time)"
# Not `dpm list-owners`: Android 11 (the WM55) has no such subcommand.
OWNER=$(s dumpsys device_policy | grep -i -A3 "device owner" | grep -o 'ComponentInfo{[^}]*}' | head -1)
echo "device owner: ${OWNER:-none}"
echo "Next: issue the pairing code in the dashboard; it is typed on the kiosk screen."
