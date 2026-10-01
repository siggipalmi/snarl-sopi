# Handover — operator self-service provisioning

**Goal:** an operator unboxes a new fridge, follows a process, and the machine ends
up selling — without Siggi on adb and without a laptop on site.

Today provisioning needs a Mac, adb, a machine key pasted into a shell, and about
half an hour of Siggi's attention per unit. There are ~44 machines left. That does
not scale, and every step done by hand is a step that has already gone wrong at
least once.

This document is the context for designing that. Read it, then the memory files
(`gravity-fridge-app`, `-backend`, `-ui`, `-infra`) which are authoritative and
current.

---

## Where things stand

Three machines live, app at **v0.49.0 / versionCode 124**.

| Machine | Type | Location | State |
|---|---|---|---|
| `8626020618` | single | Nordic Hostel | selling |
| `8626020619` | single | — | provisioned, healthy |
| `8626020716` | double | Blue Hotel | cabinet A + most of B reporting; 5 modules silent, with Weimi |

A fourth machine is at Siggi's location now and is the natural pilot for whatever
gets designed.

---

## What provisioning involves today

Every step below is currently manual and needs adb.

1. **Install the APK.** One build serves every machine — identity is NOT baked in
   (v0.46.2 onward). Built from `~/WM22/snarl-fridge-vX.XX.X`.
2. **Clear any stale identity.** `pm clear` — a fresh install otherwise adopts
   whatever `~/.gradle/gradle.properties` carried at build time.
3. **Force-stop, then provision by intent:**
   ```
   adb shell am force-stop isl.snudursopi.fridge.debug
   adb shell am start -n isl.snudursopi.fridge.debug/isl.snudursopi.fridge.MainActivity \
       --es deviceCode <code> --es machineKey <key>
   ```
   The force-stop is NOT optional: MainActivity is `singleTask`, so on a running
   app the intent goes to `onNewIntent`. That is handled since v0.45.1, but the
   backend clients stay bound to the old identity until a restart.
4. **Confirm** the log reads `provisioned deviceCode=<code> (intent)` and the
   right cabinet count.
5. **Check automatic time is ON.** Settings → System → Date & time. A wrong clock
   fails every TLS handshake and the machine reaches nothing while looking
   perfectly healthy on screen. This cost most of a day on 2026-08-28.
6. **Test the admin escape hatch** — long-press the clock top-left, PIN `123456`.
7. **Only then set Device Owner** via `dpm set-device-owner` against
   `.KioskAdminReceiver`.
8. **Tare every basket** with the machine empty (`tare_all`, force).
9. **Calibrate** against a known weight per basket.
10. **Install Tailscale**, enable Always-on VPN, note the IP.
11. **Stop the Weimi apps** — `com.weimi.monitor` and `com.weimi.gs_vendor` hold
    the serial port. Do NOT touch `com.weimi.launcher` before Device Owner is set
    and our app is home, or the board has no launcher.
12. **Upload the Nayax settings** once Nayax has onboarded the terminal, with
    **0 decimal places** for ISK. Then check the payment log line reads
    `decimal_place=0`. A terminal still on factory defaults reports
    `decimal_place=2`, and the app sends whole krónur, so a 350 kr basket would
    be charged as 3.50 kr. The app does not guard against this; this step is
    the control.

---

## Rules that must survive any redesign

**The escape hatch ships and is TESTED before Device Owner.** On 2026-07-26
Device Owner was enabled with the hatch only in a build that had to arrive over
the network. TLS then failed, the fix could not be delivered, and the machine
needed a factory reset. An escape hatch that arrives over the network is not one.

**The machine key must never appear in chat or shell history.** It has leaked into
both during this project. Whatever the new flow is, the key should not pass
through a human's clipboard if avoidable.

**Never bake identity into the build.** Two machines have provisioned themselves
as `8626020618` because `gradle.properties` held that key. The precedence is now
intent > stored > BuildConfig, and `SNARL_FRIDGE_MACHINE_KEY` should be emptied.

**A machine with no planogram still runs and looks normal.** It shows the idle
animation and the cached operator details. Anything that can silently half-succeed
will, and the operator will not see it.

---

## What already exists to build on

**The admin sheet** (`AdminClock.kt`) is PIN-gated and already the operator's
console: device code, last successful poll, system clock, Settings, Wi-Fi
settings, kiosk toggle, dev-bar toggle, and TeamViewer launch/download. This is
the obvious place for a provisioning flow — it is reachable on a kiosk with no
navigation bar, and it needs no laptop.

**Intent-extras provisioning** works and is proven on hardware.

**The command queue** reaches a machine within ~5s and needs no inbound
connection. `tare_all`, `scale_calibrate`, `scale_read`, `read_all_trays`,
`read_temp`, `set_cooling`, `sync_price_tags`, `check_update` and
`probe_addresses` are all live and allow-listed globally (backend v6.20) — a new
machine inherits them automatically.

**OTA** is proven end to end and is the delivery path once a machine is
provisioned.

**The log relay** posts the machine's own logcat to the backend every 5 minutes,
readable from the dashboard's Controls tab. No inbound connection needed.

---

## The design question

How does a machine get its identity without adb?

Options worth weighing, none decided:

- **Type it in on the admin sheet.** Device code and key entered behind the PIN.
  Needs a keyboard on a kiosk panel — the complaint form proved text entry works,
  and v0.38.3 fixed the keyboard covering the send button. A long key is painful
  to type and easy to mistype; a check digit or a QR scan would help.
- **A short pairing code.** Backend issues a 6-digit code per machine; the
  operator types that, the app exchanges it for the real key. Keeps the key off
  the clipboard entirely. Needs a backend endpoint.
- **QR code.** Operator scans a code from the dashboard with the machine's
  camera, if these boards have one. Fastest and least error-prone if available.
- **Claim-by-serial.** The machine reports its board serial on first boot; the
  operator picks it from a list in the dashboard and the backend hands down the
  identity. No typing at all, but needs an unauthenticated first contact, which
  wants thinking about.

Whatever the mechanism, the flow also has to cover: automatic time, taring,
Tailscale or a remote-support path, stopping the Weimi apps, and Device Owner —
in an order that never locks the machine before the hatch is proven.

---

## How to work well here

**Instrument before theorising.** Several days have been lost to plausible
theories diagnosed from the shape of a previous bug. Cabinet B was declared
unwired for two days when the modules were simply at addresses 20–35 rather than
16–31. Add the log first and ask Siggi for one run.

**Check what a number means before reasoning from it.** Sixteen trays reading
exactly `0g` was read as broken hardware; it meant "not asked". `updatedAt` was
read as a heartbeat when it tracks record writes.

**Siggi is at the machine and you are not.** He is technically sharp, patient, and
consistently right about the machine's behaviour when he pushes back. He does not
need softening, he needs accuracy — and a wrong instruction can cost him a drive
across the country.

**Every ask goes in a numbered list at the very bottom of the message.** Commands
in copyable code blocks, always with the full adb path
`~/Library/Android/sdk/platform-tools/adb`. Asks buried in prose get lost.
