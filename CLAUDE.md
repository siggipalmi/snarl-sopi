# snarl-sopi — notes for Claude

Backend + operator dashboard (`snarl-sopi-backend/`, Node on Railway, SQLite on a volume) for
AG Vending / Snúður & Sopi machines. Fridge app releases (`fridge-v*`) are published here.

## Merging (Siggi, 2026-10-15)

Merge your own PRs without asking, once your checks pass: the repo's tests or
`node --check`, the dashboard script parse, and an adversarial re-read of the diff.
Then tell Siggi what went out and what to check. Every change still gets its own
branch and PR, so it can be seen and rolled back.

Ask before merging anything hard to undo:
- deleting or rewriting stored data (migrations that drop or rewrite rows)
- changing how customers are charged on machines already selling
- anything that acts on the whole fleet at once

Merging a fridge-app version bump only builds a signed release. Publishing it,
cohorts, Device Owner and machine commands stay with Siggi.

## Working with Siggi

- Put every ask in a numbered list at the very bottom of the reply.
- Commands go in copyable code blocks; adb with the full path
  `~/Library/Android/sdk/platform-tools/adb`.
- Kiosk UI strings in Icelandic (with en/pl); everything else in English.
- Show a mockup before building a UI feature.
- Instrument before theorising: ask for logs/readings, don't guess hardware facts.
- Roll out one machine at a time (canary cohort), never fleet-wide first.
- The machine key must never appear in chat or shell history.
- Never bake identity into the build: one APK for every machine.
- Never paste the keystore anywhere; secrets live as GitHub Actions secrets.

## Coil machines, Weimi and first setup (2026-10-21)

- The coil app resolves the **vélarnúmer** against Weimi's cloud, not against us. When Weimi
  answers `{"list":[]}` the kiosk says **"Vél fannst ekki"** and setup stops there. That string is
  the app's own — every not-found in our backend reads "Vélnúmer X er ekki skráð".
- **An empty Weimi record usually means the machine is assigned to a sub-operator**, not that it
  is unregistered: our `appId` only sees the parent account. 31 of 71 machines read empty on
  2026-10-21, 19 of them coil. Do NOT report these to Weimi as missing devices — it is correct
  business state, and we nearly sent that list as a bug report.
- The lookup matters **only at first setup**. `62160491` is live and selling while invisible to our
  Weimi credentials. So to commission a sub-operator machine: move it back to the parent account,
  enter the vélarnúmer, then reassign it.

- **…but entering the vélarnúmer does NOT give the machine a usable key.** Confirmed on
  `62160479`, 2026-10-23: after pairing, the app sends its own **device code** as
  `X-Machine-Key`, so every call 401s. The machine sells normally (Nayax and the control board
  do not involve us) while reporting nothing, and reads as offline. Re-pairing cannot fix it and
  a site visit is wasted — the app has to obtain a key from `/api/v1/machines/provision`, which
  this build does not do. `OPEN-ISSUES.md` in the coil app flagged exactly this at ~v0.50.5
  ("deviceCode used as a placeholder machine key") and it is still true at 0.78.2.

- **Fixed from coil 0.79.0: the app pairs with a six-digit code** from the dashboard
  (`/api/v1/provisioning/pair`), which hands it its own key. Both Grótta machines (`62160479`,
  `62160484`) were commissioned this way on 2026-10-25 and report with real keys. A machine still
  holding an old identity gets to the pairing screen through PIN → "setja upp nýjan sjálfsala",
  which keeps its local settings — prefer it to wiping app data.
- Coil machines that DO work appear to carry a key **baked into their APK** at build time
  (`TEST_MACHINE_KEY` in `local.properties`). `62160492` connects to the proxy with a valid key,
  and the proxy validates before accepting, so that machine holds a real one. That contradicts
  "one APK for every machine" and is why a generically-built coil APK produces a keyless machine.
  The fridge app made this transition at v0.46.2; the coil app has not.

- **Diagnosing it costs nothing:** since 6.72.0 the log says which case a machine is in —
  `[AUTH] <code> invalid key xN.` followed by whether it is sending its device code, a
  real-shaped key, or nothing. Check that before sending anyone anywhere.
- Nothing in `src/weimi.js` can register a device. The writes are aisle and goods only, against a
  device that already exists.
- Check with `/api/v1/debug/weimi-device?deviceCode=X`, which uses the backend's own credentials
  rather than the app's. (Those `debug/weimi-*` routes have no auth middleware — worth fixing.)
- Fridges do not resolve identity through Weimi and are unaffected.
- **Restock on a kiosk-run coil machine: set stock source to Kiosk** (Display Settings → machine →
  stock source). On Weimi stock, a restock is pushed through Weimi's cloud, which refuses it with
  4003 "machine offline" unless Weimi's own app on the board holds its link — and during setup
  `com.weimi` and `com.weimi.monitor` get disabled so they stop fighting our app for the screen.
  Both Grótta machines hit exactly that on 2026-10-25; re-enabling `com.weimi` and rebooting did
  not bring Weimi's link back within minutes. On Kiosk the backend owns stock, the coil app reads
  it every config poll (2 min), and the Weimi sync keeps our counts while still taking names,
  prices and slot layout from Weimi. Both Grótta machines were switched to Kiosk that day. New
  coil machines already default to it.
- **A black, deaf screen with the app alive underneath (Grótta, 2026-10-26/27).** Both machines went
  dark within hours of each other and stayed so for three days while the dashboard said online and
  `config_health` answered. System logs showed no crash, no ANR, no kill; the app died as `fg TOP`
  when "restart app" finally fixed it. What the logs did show: **power dips at the site** resetting USB
  on both machines at the same moments (touch screens Sun 12:06–12:13, the Huawei Wi-Fi stick — which
  is powered from hægri's USB port — and a second USB device on both Mon 08:54), with hægri's last sale
  inside that Sunday window. Both machines are on one wall branch. The app's own log lines had been
  pushed out of the on-device buffer, so the exact mechanism is unproven. From 0.80.2: a screen
  watchdog (`ScreenWatchdog.kt`) restarts the app when its window stays black or stops drawing; the ad
  video draws as a TextureView, not a SurfaceView; the app relays its log to the backend (`LogRelay.kt`,
  dashboard → machine → logs) so the next incident leaves a record.
- **The coil ad region played a hard-coded playlist until 0.80.2**, including a Big Buck Bunny clip
  streamed from Google on every rotation — a download every few minutes, around the clock, over the
  SIM. From 0.80.2 it plays the backend's per-machine list (the machine's own, else its operator's,
  set in the dashboard) and only from a local copy (`AdCache`): each file is downloaded once, played
  from disk, and removed when unlisted. A machine with no ads configured shows no ad region.
- **OTA never ran on its own at Grótta before coil 0.80.3.** The app skipped its hourly update check
  whenever Android called the network metered, and the SIM router's Wi-Fi is flagged metered (its
  capabilities carry no `NOT_METERED`; read with `dumpsys connectivity` on 62160484, 2026-10-27).
  Two days online, no check, header "app unknown", and no log line to say why. From 0.80.3 the check
  runs regardless, five minutes after start and hourly after, logs its outcome every time, and the
  dashboard's `check_update` command works on coil too. Any coil machine still below 0.80.3 can
  only be updated over adb.
- **Nayax names are labels, not links.** The reader in Grótta vinstri (Nayax machine 227890869)
  is named "62160481-Grótta vinstri" in Nayax, but 62160481 is Klettatröð – IWO. The backend
  links readers by the numeric Nayax ID set by hand (`nayaxMachineId`), never by the name — check
  the ID, not the label, before believing which machine a sale belongs to.
- The dashboard header's **"app v0.21"** is seed data from `src/db.js` that nothing updates; the
  real build is the number in brackets, filled in by the app's hourly update check.

## Aisle dispensing modes (2026-10-22)

Every Weimi aisle carries a `shippingMode`. The fleet digests tally it and used to say nothing
about what the numbers mean:

| value | mechanism |
|---|---|
| 1 | spiral / coil |
| 2 | direct push |
| 4 | gravity fridge |

Mode 2 confirmed by looking at the machines: Stjarnan (`62160480`) and Laugardagshöll
(`62160478`) each have 14 direct-push slots, 7 per layer across 2 layers, with the other 36
aisles mode 1. It had been guessed at as a twin-spiral mode first.

**Twin spirals are not a shippingMode.** Valur I (`62160043`) has three aisles on its top layer
driven by two spirals each, and reports `modes: {1: 43}` — every aisle mode 1, with an odd total
consistent with each pair being merged into a single aisle. So the board can already drive two
spirals from one selection; how that is configured, and how it appears in device-info, is not yet
established. Weimi said "the board needs work" when asked, which is hard to square with a machine
of theirs already doing it.

**Nothing on our side can configure this.** The Weimi writes in `src/weimi.js` cover stock,
capacity, goods info and goods assignment only — no dispensing configuration. And the backend has
no concept of two aisles being one product: a twin-spiral aisle would need the planogram to show
one tile, price it once and decrement both.

## Nayax readers: a guest can reset them (2026-10-26)

Blue Hotel (`8626020716`) stopped taking cards at 01:21 UTC. The reader's own log showed
`Def. Params. Set.` + `Power Down`, then `Roll Call V00`, no `Marshall:` traffic, DEX attempts, no
MQTT and the server ping moving from 1000 s to 3000 s. That is a **factory reset done on the reader**:
a guest guessed the technician code (Nayax default `123123`) and pressed everything. Nothing shows
in Nayax Core's machine or queue history, because Core still holds the right settings; the reader
lost its copy and stops receiving commands until its next check-in (~50 min), when it came back.

- Both sides timing out (`Marshall: Mac,Err: Rx timeout` on the reader, `no onReady … 90s` in the
  app) means reader config or cabling, never our port choice.
- Technician codes are set in Nayax Core (VPOS Touch group attributes → Technician Code). Never
  leave a reader on the default.
- Our own admin sheet has the same exposure on apps older than 0.69.0 (shared `123456`, no
  lockout). Give every placed machine 0.69.0+ and its own PIN.

## Setting up a new machine

- **Check `auto_time` first.** `settings get global auto_time` must be `1`. A wrong clock fails TLS
  silently: the machine reaches nothing while the screen looks perfectly healthy. It was `0` on
  62160479, and that failure has cost days on three other machines.
- **A power cut can put the clock back years.** 62160479 came back reading **19 May 2023** with
  `auto_time` off (2026-10-24) and sold nothing for two days. What the screen showed was a Weimi
  catalog failure, `SSLHandshakeException … Certum Trusted Network CA … insecure hash function` —
  which reads like Weimi's certificate and is not a reason to contact Weimi until a correct clock
  has been tried. **Confirmed 2026-10-25:** with the clock right, 62160479 loaded its catalog from
  Weimi at once — the certificate was never the problem. Check the date in the pull-down shade
  first; it is reachable from the setup screen, where the clock long-press is not.
- From coil 0.80.0 the app says **"klukkan í vélinni er röng"** on the setup and error screens and
  switches automatic time back on at every start — as Device Owner, or after a one-time
  `pm grant isl.snudursopi.vending.debug android.permission.WRITE_SECURE_SETTINGS`.
  `coil-app/tools/adb-onepass.sh IP:PORT` does every adb step in one re-runnable pass, grant included.
- A device code **on the kiosk screen proves nothing** — it is cached local state. Confirm from the
  dashboard: a command leaving `pending`, or the key going `active`.
- Wireless-debugging uses a **new random port every reboot**, and reading it needs eyes on the
  screen. Front-load every adb step before the first reboot.

- **While you still have adb, pin the port.** This costs nothing and has to be done before the
  window closes, which is precisely when nobody thinks of it:

      ~/Library/Android/sdk/platform-tools/adb -s <ip:port> shell setprop persist.adb.tcp.port 5555
      ~/Library/Android/sdk/platform-tools/adb -s <ip:port> shell getprop persist.adb.tcp.port

  Set on `62160484` on 2026-10-23. On 2026-10-25 `adb connect 100.74.205.17:5555` connected with
  nobody at the screen. But after a **deliberate reboot** the same day, adb was next reached on the
  Wireless-debugging port (46843), and whether 5555 also answered then was not checked. So: it
  worked once after an unwitnessed restart; it is **not yet proven across a witnessed reboot**.
  Try 5555 first after the next one before relying on it. `62160479` was pinned the same day (by
  `adb-onepass.sh`, which pins every machine it touches).

  Do NOT run `adb tcpip 5555` on a machine whose connection you cannot afford to lose: it restarts
  adbd and drops the current session to come back on the new port. Save it for after the work is
  done.

- **A machine with no valid key cannot be updated over the air.** `app-update` is machine-key
  gated, so it never learns an update exists; the APK route being open does not help. That is how
  both Grótta machines ended up fixable only by adb — worth remembering before relying on OTA to
  rescue anything.
- Stop `com.weimi.monitor` before the other Weimi apps — it restarts them. Do **not** disable
  `com.weimi.launcher` until our app is Device Owner **and** set as home. On 62160479 no default
  home was set at all, so HOME resolved to Android's launcher picker.
- Device Owner last, after the admin escape hatch has been tested on the machine itself. Once set,
  the app cannot be force-stopped, cleared or uninstalled by anything but itself.

## This repo

- Bump `snarl-sopi-backend/package.json` version on every change; Health shows it.
- Check: `node --check` on changed `src/*.js`, and parse the `<script>` blocks of
  `public/index.html`.
- Never ship real fleet data (machine names, codes, prices) inside `index.html`; the
  dashboard gets everything from the backend, scoped to the signed-in user.
- **Coil releases build themselves**, like fridge: bump `versionCode` + `versionName` in
  `coil-app/app/build.gradle.kts` and merge. `.github/workflows/coil-release.yml` builds, refuses a
  build carrying a machine identity or signed with any key but the fleet's (cert `c3d1dfdb…`, the
  same key as the fridge fleet), and attaches a `coil-v<name>` release here. It needs the
  `DEBUG_KEYSTORE_BASE64` secret on *this* repo. Publishing it (Fleet → Releases → coil → load
  latest build) stays with Siggi, as for fridge. Coil installs are the `isl.snudursopi.vending.debug`
  package, signed with the debug keystore.
