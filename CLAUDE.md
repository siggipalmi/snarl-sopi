# Snúður & Sopi — working notes

Vending fleet for the Icelandic market: gravity fridges and spring-coil
machines, an operator dashboard, and a marketing site.

> **This repository is PUBLIC.** No keys, no PINs, no machine keys, no
> `.env` contents — in code, in docs, or in a commit message. A live
> `mk_live_` machine key was committed in `local.properties` on 2026-09-06
> and had to be rotated. Check `.gitignore` before adding a new subproject.

---

## What is in here

| Path | What it is | State |
|---|---|---|
| `snarl-sopi-backend/` | Node 20, no framework. Operator API, dashboard, machine contract. | Live, actively developed here |
| `agvending-site/` | Static marketing site, Cloudflare (`wrangler.toml`). | Live |
| `coil-app/0.78.2/` | Android app for Weimi WM55 coil machines. | **Broken stub** — see below |
| `app-version.json` | Legacy OTA manifest (versionCode 113). | Superseded by the backend's app-release endpoints |

**The gravity fridge Android app is not in this repository.** It is the
package `isl.snudursopi.fridge`, at v0.54.0 / versionCode 135, and it lives
on Siggi's Mac at `~/AndroidStudioProjects/WM22`. Backend features
routinely block on it — v6.31 shipped a lighting panel whose only honest
state is "this build does not handle `set_led`" until the app lands
`ctlLed`. Bringing it here is the open task.

**`coil-app/0.78.2/` does not build.** `settings.gradle.kts` declares
`include(":app")` and there is no `app/` module — only the Gradle wrapper
and root build files were ever uploaded. The `README.md` in it describes
v0.1 while the directory says 0.78.2, so the two disagree about which
version this even is. Treat it as scaffolding, not source.

---

## Conventions

**Version is the changelog.** `snarl-sopi-backend/package.json` carries the
version in `version` and a full prose changelog in `description`. Bump both
in the same commit as the change.

**Commit messages are long and explain the reasoning**, not the diff. Look
at `git log` before writing one. The house style: subject line
`vX.Y.Z: what changed, in plain words`, then body paragraphs covering what
was wrong, why the fix is shaped this way, what was removed and how it was
verified to be safe to remove, and a closing scope note (`Frontend only.`).

**Frontend is one file.** `snarl-sopi-backend/public/index.html` is ~9.8k
lines of dashboard. `src/router.js` is ~6.8k lines. Both are edited in
place; there is no build step.

---

## The machine-facing contract

Machines authenticate with `X-Machine-Key` (`requireMachineKey` in
`src/router.js`). A key is scoped to one device code and authorises:
reading `/config`, `/commands`, `/product-details`, `/app-update`; posting
`/sales`, `/fridge/settlement`, `/telemetry`, `/logs`, `/complaints`, and
command results. It does **not** grant dashboard access — but it can write
sales into a system that drives invoicing and payday ledgers, so a leaked
key is a financial-integrity problem, not just a privacy one.

**There is no safe remote key rotation for a live machine, and the obvious
sequence bricks one.** `validateMachineKey` (`db.js:342`) is a strict
compare against exactly one stored key — no second key, no grace window.
`issue-key` refuses while a key is active ("would lock out the running
machine"); revoking is the only way past that refusal; and once revoked,
the `set_machine_key` command refuses too ("the machine will 401 and need a
site visit"). A machine fetches commands *with* the key you just killed, so
the replacement can never reach it. `set_machine_key` only pushes the key
already on record (`router.js:1950` deliberately overwrites any supplied
value, to keep keys out of browser history), so it cannot rotate anything.

Rotating a placed machine therefore means a site visit, downtime, or a
backend change first. Whether the kiosk can self-recover through
`POST /api/v1/machines/provision` (PROVISION_SECRET, no machine key needed)
on a 401 is an **app-side question that cannot be answered from this
repository** — it is one of the things the app source needs to be here for.

**Command types** are allow-listed globally in `CMD_TYPES` (`src/router.js`),
so a new machine inherits them automatically. Currently: `clear_aisle_fault`,
`set_aisle_enabled`, `sync_price_tags`, `test_vend`, `dispense_log`,
`config_health`, `set_machine_key`, `tare_all`, `read_all_trays`,
`read_temp`, `launch_support`, `clear_device_owner`, `set_payment_port`,
`set_drop_sensor`, `query_channel_status`, `restart_app`, `restart_machine`,
`set_temp`, `set_cooling`, `defrost`, `fridge_open_door`, `set_led`,
`scale_read`, `scale_calibrate`, `scale_tare`, `check_update`.

Adding a command means both sides: the allow-list here and the handler in
the app. A machine that does not implement one answers "this build does not
handle '<type>'" — which is why capability is recorded from the answer
(`ledcap:`, `confighealth:` in meta) rather than assumed.

**OTA does not depend on this repository.** At publish time the backend
fetches the APK once from `apkUrl` and stores it on its own persistent
volume (`fetchAndStoreApk`); machines then download from
`/api/v1/app-release/:app/apk`, unauthenticated, over the TLS chain they
already trust. This is deliberate — some older kiosk tablets lack GitHub's
newer ISRG X2 root — and it means a publish pointing at a dead URL fails at
publish rather than shipping an unusable release. `:app` is `fridge` or
`coil`; the fridge slot already exists. Only the current APK per app is
kept. **Consequence: the repository's visibility is invisible to machines.**
Only the publish step needs a URL the backend can fetch unauthenticated, and
`apkUrl` must be https.

**These three outbound channels have never failed** except when the
machine's own link was down, and they need no inbound connection, port, or
VPN: the command queue (~5s to reach a machine), OTA, and the log relay
(the app posts its own logcat every 5 min, readable in the dashboard's
Controls tab — the single most useful diagnostic in the project).

---

## Hardware facts that were expensive to learn

Each of these was first diagnosed wrongly. None can be inferred from
documentation or from the other machine types.

**Machine type comes from `model`, never from the device code.**
`fridgeSpec` (`db.js:468`) is the single classifier: a model starting `GR-`
is a fridge, and one containing `1260` is a double (32 baskets, 2 doors)
against 16 and 1 otherwise. Everything downstream hangs off this — which
app a machine gets in the release list, its cabinet count, and through that
the default payment port.

Device codes *do* follow a convention — `86260206xx` are the gravity
fridges, `62xxxxxx` the coil machines — but **no code reads the prefix**,
so it is a naming habit, not a guarantee. Set `model` correctly and do not
infer type from the number.

**Serial ports differ by machine type. There is no pattern.**

| Machine | Nayax payment | Other |
|---|---|---|
| Gravity fridge, SINGLE cabinet | `/dev/ttyS4` | weight bus `ttyS3` |
| Gravity fridge, DOUBLE cabinet | `/dev/ttyS1` | weight bus `ttyS3` |
| Coil machine (WM55) | `/dev/ttyS3` | motors `ttyS1` @ 9600 |

Nayax is 115200 8N1 on all of them. Do **not** collapse these — the double
was diagnosed first and the default was changed fleet-wide on the strength
of it, which would have broken payment on every single-cabinet fridge
including the one taking real money. A wrong port looks exactly like a dead
cable: the port opens, `link.start()` succeeds, `onReady` never arrives, not
one byte is received, and neither side reports an error.

**Gravity module addressing: cabinets are 20 apart, not 16.**
Cabinet A basket 1–16 → tray 0–15; cabinet B basket 1–16 → tray 20–35.
Trays 16–19 exist on no machine. Reads must be two calls —
`multiReadModuleWeight(16, 0)` and `(16, 20)` — because a contiguous sweep
of 36 from 0 burns six retries on each absent address and browns out the
bus, cycling the cabinet lights and compressor. The same arithmetic once
existed in two places and the second was missed, landing a tare aimed at B5
on B1. Basket numbers in commands are 1-based; tray indices in logs are
0-based.

**Temperature is in the acknowledgement.** `ctlTemp(addr, 0, 0)` reads,
`ctlTemp(addr, 1, degC)` writes (whole degrees, clamp 1..15). Parse the
0x4A reply's data hex: `[20:24]` cabinet temp, signed 16-bit big-endian,
tenths of °C (signed matters — `0xFFEC` is −2.0 °C, not 6553.2); `[36:38]`
sub-command, setpoint valid only when `00`; `[38:40]` setpoint in whole °C.
`ctrlCompressor` is acknowledged and ignored — the board runs its own
thermostat and the setpoint is the only way to reach it.

**The board's clock cannot be trusted after a power cut**, and a wrong
clock fails TLS *silently*: the machine reaches nothing while looking
perfectly healthy on screen, cached operator details and all. Automatic
time must be on. This cost most of a day.

**Device Owner is absolute.** Once set, the package cannot be
force-stopped, cleared, or uninstalled — from Settings or adb; all three
fail. Only the app can surrender it, which is what `clear_device_owner`
(guarded) exists for; otherwise the route is a factory reset, which on a
placed machine destroys Tailscale, TeamViewer and wifi at once.
`restart_app` exists because nothing external can restart a Device Owner
app. Setting Device Owner fails if **any** account has been added.

**The Weimi apps hold the serial ports.** `com.weimi.monitor` restarts
`com.weimi.gs_vendor`, so stop the monitor first. Do **not** disable
`com.weimi.launcher` before our app is Device Owner and set as home, or the
board has no launcher.

**Withdrawn:** `probe_addresses` (v0.49.1) reported "no modules on the bus"
in the same minute `read_all_trays` returned 27 working trays. Use
`read_all_trays`. `getTemplate` is silent at every address tried.
`getEleInfo` (0x47) is electrical metering, not temperature — its 0x0046
field is 0.70 A, not 7.0 °C.

---

## Rules that must survive any redesign

**The escape hatch ships and is TESTED before Device Owner.** On 2026-07-26
Device Owner was enabled with the hatch only in a build that had to arrive
over the network. TLS then failed, the fix could not be delivered, and the
machine needed a factory reset. An escape hatch that arrives over the
network is not one.

**Never bake identity into the build.** Two machines provisioned themselves
as the same device code because `gradle.properties` held that key.
Precedence is intent > stored > BuildConfig.

**The machine key must never pass through a human's clipboard**, chat, or
shell history if it can be avoided. It has leaked into all three.

**A device code on the machine's screen does not mean it is talking to the
backend.** It is cached local state. The only proof of a live link is the
backend's side: a command leaving `pending`, or last-seen advancing. On
`8626020623`, 2026-09-17, a restart made the correct device code appear on
screen while every queued command stayed pending — the machine was not
polling at all. Restarting is still the cheap first move before adb and an
intent, because re-provisioning a machine that was already correct is how a
wrong key gets typed in, but confirm it from the dashboard, never from the
screen.

**A machine with no planogram still runs and looks normal.** Anything that
can silently half-succeed will, and the operator will not see it.

---

## How to work well here

**Instrument before theorising.** Days have been lost to plausible theories
diagnosed from the shape of a previous bug. Cabinet B was declared unwired
for two days when its modules were simply addressed from 20 rather than 16.
Add the log first and ask for one run.

**Check what a number means before reasoning from it.** Sixteen trays
reading exactly `0g` was read as broken hardware; it meant "not asked".
`updatedAt` was read as a heartbeat when it tracks record writes.

**Siggi is at the machine and you are not.** When his account of events
conflicts with an inference from logs, weight his account heavily — it has
been right every time. A wrong instruction can cost him a drive across the
country.

**Every ask goes in a numbered list at the very bottom of the message**,
commands in copyable code blocks, always with the full adb path
`~/Library/Android/sdk/platform-tools/adb`. Asks buried in prose get lost.

---

## Open threads

- **Unattended remote access** — the one capability the project lacks.
  Tailscale has failed three distinct ways, each needing someone at the
  machine. adb is not a remote channel on these boards: Android 11
  randomises the wireless-debugging port every reboot, and a Device Owner
  app cannot re-arm `adb tcpip 5555`. Untested idea: TeamViewer **Host**
  (not QuickSupport) with its accessibility add-on enabled silently via
  `DevicePolicyManager.setSecureSetting(ENABLED_ACCESSIBILITY_SERVICES, …)`,
  which Device Owner permits. Unverified on this hardware, and unattended
  Android access is a paid TeamViewer feature — confirm the licence before
  designing the fleet around it.
- **Operator self-service provisioning** — ~44 machines left; today each
  needs a Mac, adb, and ~30 minutes. The PIN-gated admin sheet
  (`AdminClock.kt`) is the natural home. Mechanism undecided: typed key,
  short pairing code, QR, or claim-by-serial.
- **Blue Hotel `…716` cannot take payment** — `onReady` never fires. Cable,
  baud, and firmware ruled out. Next test: run Weimi's own app against the
  same terminal; if its VMC handshakes, the fault is ours. Note this
  machine is a double, so the port is `ttyS1` (see the table above).
