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
- **A blank cream screen with the app alive underneath (both Grótta machines, 2026-10-28)** is an
  EMPTY NAVIGATION STACK: `uiautomator dump` showed six nodes and no text, the activity resumed,
  the main thread idle and answering polls. A plain `popBackStack()` on a stack of one (a second
  tap on back/cancel during the exit animation of the screen being left) empties the NavHost,
  which then composes nothing. **Confirmed by Siggi the same evening on 62160492 (0.80.9):
  tapping "Til baka" rapidly on a product's info page blanks the screen on demand.** From coil 0.80.13 every back goes through `popOrHome()`, an empty
  stack navigates home by itself, route changes are logged (`Nav:` in the relayed log), and the
  screen watchdog restarts on a flat window of any colour, not only black. The "black, deaf
  screen" of 10-26 very likely was the same thing. Diagnose with:
  `adb shell uiautomator dump /data/local/tmp/ui.xml; grep -c '<node' /data/local/tmp/ui.xml`
  (a healthy screen has dozens of nodes), and `restart app` from the dashboard recovers it.
- **A board can stop executing for 44 minutes with nothing wrong in the app (Grótta vinstri,
  2026-10-27 19:31 and 2026-10-28 04:44).** Every process went silent for exactly 2,681 s each time,
  the kernel's own 60-second heartbeat included; the kernel never suspended (`suspend_stats` 0),
  its clock kept counting, and the board came back on an interrupt from outside the CPU — the
  router dropping the silent client after its inactivity timeout. Hægri, same board, same wall
  branch, same router, never stalled; it has a USB device (the Huawei stick) interrupting all the
  time. Reading: all four cores in `cpu-sleep` (residency 1 ms) and the timer wake lost. Power was
  ruled out: the sockets are behind bolted machines, and a mains dip would have hit both.
  Detector: `dmesg | grep healthd` gaps (one line a minute while the kernel runs) and the payment
  SDK's `starved for Nms` line in the relayed log. Workaround under test: the **idle guard**
  (machine page → Controls → idle guard, AG only; coil 0.80.12+, fridge 0.70.5+), a thread waking
  every 500 µs that keeps one core in the light idle state. Canary vinstri; compare heartbeat gaps
  over 24 h before switching it on anywhere else.
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
- **Coil OTA is proven end to end (2026-10-27):** Valhúsaskóli `62160492` went 0.80.8 → 0.80.9 from
  a dashboard publish to canary, installed silently as Device Owner and came back selling with
  nobody at the machine. What it took: an app of 0.80.3+ (check runs on metered networks), a
  **stored key** (`config_health` → `keySource=stored`; the backend withholds generic builds from a
  machine whose key is baked into its APK, and from 6.76.4 the manifest and the kiosk say so:
  "vantar geymdan lykil — para vélina fyrst"), and Device Owner. 62160492 had run build 137 with a
  baked key; it was brought to 0.80.8 over adb once, paired, and has updated itself since.
- **The key state is in the machine header** from 6.76.5: `key stored`, `key build — pair first`
  or `key unknown` (never asked; run `config_health`). The machine page reads `/machines/:code/detail`,
  which until 6.76.5 carried neither the health snapshot nor the version name — hence a bare
  `app (164)` and a health banner that had never shown.
- **Nayax names are labels, not links.** The reader in Grótta vinstri (Nayax machine 227890869)
  is named "62160481-Grótta vinstri" in Nayax, but 62160481 is Klettatröð – IWO. The backend
  links readers by the numeric Nayax ID set by hand (`nayaxMachineId`), never by the name — check
  the ID, not the label, before believing which machine a sale belongs to.
- **Wireless debugging from the dashboard (AG only): `adb on` / `adb status` / `adb off`** on the
  machine page, fridge 0.70.0+ and coil 0.80.8+. The answer in the command history carries the
  `adb connect <tailscale-ip>:<port>` line, so nobody has to read the port off the screen. It needs
  the one-time `pm grant … WRITE_SECURE_SETTINGS` on the machine (the same grant ClockGuard uses;
  `adb-onepass.sh` does it); `adb status` says whether it has it. Switch it off when done.
- **Out of service works on coil from 0.80.7** (fridge since 0.68.0): the dashboard switch (Controls →
  close this machine, with a reason) and AG's master close cover every customer screen with
  "Lokað tímabundið"; a payment already in flight finishes first, and the clock long-press → PIN
  path stays open for a technician. Coil machines below 0.80.7 ignore the switch and keep selling.
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

- **A stuck customer screen locks out every remote command (2026-11-02).** Blue Hotel sat on a
  customer phase from before 01:33 to past 05:33 with nobody there; `restart app` logged
  `a customer session is live — deferring` and then expired (commands live 5 min, `CMD_TTL_MS`).
  Nothing bounded the complaint form, and a charge result landing after the receipt timer put the
  receipt back with no timer. From fridge 0.70.7 (`StuckSession.kt`) a phase unchanged for 15 min
  stops blocking commands, post-payment screens return to idle by themselves, and the log says
  `STUCK on <phase>`. Below 0.70.7 only someone at the screen can clear it.
- **A reader can hold decimal_place=2 while Nayax Core says 0 (Blue Hotel, 2026-11-02).** 716's reader
  (serial 0434333224290734) reported `decimal_place=2` at every Marshall handshake after a guest reset
  and a full config reload, while Core showed Decimal Place 0 and every other fridge reported 0. It
  still charged correctly (350 sent, kr 350,00 in Nayax), and rebooting the reader did not change it.
  **What fixed it: in Core, set Decimal Place to 2, push, then back to 0, push** (machine closed for
  sale meanwhile). The next handshake read 0. The merchant ID it reports changed at the same time
  (`d448` → `cbe4`) — check it against the other fridges after doing this.
- Both sides timing out (`Marshall: Mac,Err: Rx timeout` on the reader, `no onReady … 90s` in the
  app) means reader config or cabling, never our port choice.
- Technician codes are set in Nayax Core (VPOS Touch group attributes → Technician Code). Never
  leave a reader on the default.
- Our own admin sheet has the same exposure on fridge apps older than 0.69.0 and coil apps older
  than 0.80.6 (shared `123456`, no lockout). Give every placed machine a newer app and its own PIN
  (machine → admin PIN → new PIN; the hash reaches the machine with its next config poll).

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
  Try 5555 first after the next one before relying on it.
  **Disproved on `8626020606` (2026-11-01):** pinned at setup, and after the tablet's next restart
  `adb connect 100.119.126.13:5555` was refused. Do not count on 5555 coming back. `62160479` was pinned the same day (by
  `adb-onepass.sh`, which pins every machine it touches).

  Do NOT run `adb tcpip 5555` on a machine whose connection you cannot afford to lose: it restarts
  adbd and drops the current session to come back on the new port. Save it for after the work is
  done.

- **Grant the fridge app WRITE_SECURE_SETTINGS while you have adb** (fridge 0.70.0+). It lets the
  dashboard switch wireless debugging on and read its port (machine page → Controls → *adb on*,
  AG only), so the next adb session needs nobody at the screen. Device Owner does not give it:

      ~/Library/Android/sdk/platform-tools/adb -s <ip:port> shell pm grant isl.snudursopi.fridge.debug android.permission.WRITE_SECURE_SETTINGS

  *adb status* reports whether a machine has it. Only computers already paired with the machine
  can connect; switch it off (*adb off*) when done.
- **Allow the site's Wi-Fi for wireless debugging while you are there.** On `8626020606`
  (2026-11-01) *adb on* switched it on, never got a port, and Android had it off again within
  minutes, twice, grant held and Tailscale up. Most likely Android 11's "Allow wireless debugging
  on this network?" prompt, unanswered on a kiosk (unconfirmed — nobody saw the screen). On site:
  Settings → Developer options → Wireless debugging → tick **Always allow on this network**.
- **From fridge 0.70.6 the app makes Tailscale the always-on VPN** (`shared/TailscaleVpn.kt`), so it
  comes back after a restart. 606 had lost it; the update alone brought it back (on `tun1`, not
  `tun0` — never look for Tailscale by interface name).

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

- **Both apps live here since 2026-10-27:** `coil-app/` and `fridge-app/` (the former
  `siggipalmi/snarl-fridge`, imported with its history by `git subtree add`; that repo is to be
  archived). Each keeps its own Gradle project, version line, package and CLAUDE.md. Fridge
  releases now build from `.github/workflows/fridge-release.yml` here, same shape as coil's, with
  the repo's own token. Anything that must behave the same on every machine (updater, log relay,
  clock guard, screen watchdog, Nayax link and status report, pairing) is to be built once and
  shared between the two, not ported by hand a second time.
- **`shared/` is that place** (coil 0.80.5 / fridge 0.69.4): an Android library both app builds
  include (`project(":shared")` with `projectDir = ../shared`). It holds self-healing (crash
  recovery, watchdog, relaunch), the auto-revert `RecoveryGuard`, the APK installer, `ClockGuard`,
  `ScreenWatchdog`, `AppVersion` (read from the package manager, never `BuildConfig`) and the
  payment-status reporter. **The receiver classes stay in each app under their old names**
  (`WatchdogReceiver`, `update.UpdateResultReceiver`, `KioskAdminReceiver`): alarms and installer
  callbacks set by the build being replaced are explicit Intents for those names, and Device Owner
  is recorded by that component name. Each app hands them to `Kiosk.init(...)` first thing in
  `Application.onCreate`. Local builds: both apps need `local.properties` with `sdk.dir`;
  `shared/build` is one directory, so build the two apps one after the other, not at once.

- Bump `snarl-sopi-backend/package.json` version on every change; Health shows it.
- **Never answer an error with 502 or 504.** Something in front of the backend swaps those for its
  own HTML page, so the dashboard shows "Backend may be restarting (HTTP 502)" and the real message
  is lost. Use **424** when an outside service (Payday, Weimi, Nayax, email) failed; **503** is safe
  too. Measured from `admin.agvending.is` on 2026-11-04 (backend 6.106.7): 424 and 503 arrived
  intact, 502 and 504 were replaced. The page starts like Cloudflare's error template, so it is
  probably Cloudflare on the custom domain rather than Railway (not checked on `up.railway.app`).
  Repeat the test after any hosting change: `GET /api/v1/debug/status-probe?code=N` (AG only)
  answers status N with a body containing `"marker":"snarl-sopi-status-probe"`; if the marker
  arrives, that status passes through.
- Check: `node --check` on changed `src/*.js`, and parse the `<script>` blocks of
  `public/index.html`.
- Never ship real fleet data (machine names, codes, prices) inside `index.html`; the
  dashboard gets everything from the backend, scoped to the signed-in user.
- **Public screenshots** (`public/assets/shots/`, and the web copies on agvending.is/kerfid) are
  taken on invented data, never the real fleet: an empty database seeds the REAL machines.
  `DB_PATH=/tmp/demo.db node tools/demo-data.js`, start the server on that file, sign in as
  `demo@agvending.is` / `demo-screenshots` (an operator admin) with the dashboard in IS, and shoot
  desktop 1440×900 @2x and phone 390×844 @3x. The site's copies get NEW file names (its /assets
  is cached for a year).
- **Coil releases build themselves**, like fridge: bump `versionCode` + `versionName` in
  `coil-app/app/build.gradle.kts` and merge. `.github/workflows/coil-release.yml` builds, refuses a
  build carrying a machine identity or signed with any key but the fleet's (cert `c3d1dfdb…`, the
  same key as the fridge fleet), and attaches a `coil-v<name>` release here. It needs the
  `DEBUG_KEYSTORE_BASE64` secret on *this* repo. Publishing it (Fleet → Releases → coil → load
  latest build) stays with Siggi, as for fridge. Coil installs are the `isl.snudursopi.vending.debug`
  package, signed with the debug keystore.

## Release notes (2026-10-29)

- **Every version bump adds an entry to `snarl-sopi-backend/release-notes.json`**, in the same PR:
  `component` (`coil` | `fridge` | `backend`), `version`, `versionCode` (apps), `date`, a one-line
  `title`, `notes` (bullets, in English, written for Siggi and operators: what changed on the machine
  or the dashboard, not which file moved) and an optional `check` (what to look at on the canary).
  The dashboard's last row, "what's new", reads this file through `GET /api/v1/release-notes` and
  marks each app build with how many of the caller's machines run it and whether it is the
  published release (canary / all); the backend tab (AG only) marks the version Railway is running
  as live. Operators see the two app tabs for their own machines.

## Stock counts on Kiosk machines (2026-11-11)

- **Grótta vinstri read 0 on eight full bays (2026-11-10)** and nothing could say how. From backend
  6.115.0 every change to a bay's count on a Kiosk-stock machine is a row in `stock_ledger` with its
  cause (`sale`, `sale_spill`, `sale_skipped`, `sale_unmatched`, `restock` + who, `sync_new_bay`,
  `sync_bay_removed`, `sync_product_changed`), read at `GET /machines/:code/stock-ledger` and shown on
  the machine page → Planogram → "count changes" (tap a slot to filter). Check it before theorising
  about a count.
- **The Weimi sync writes Weimi's counts nowhere for a Kiosk machine.** It still brings names, prices
  and the slot layout; counts, restock dates and the `needsCount` flag are carried per bay code. A bay
  code it has never seen starts at **0 with `needsCount`** (tile badge "telja") rather than Weimi's
  stale number, so renumbering aisles in Weimi's portal shows up as "set count" tiles, not as silent
  zeros or a stale figure selling air. Machine totals and sold-out tracking read our layout.
- The coil app still loads its **catalog from Weimi's cloud** (device-info, its own credentials) and
  overlays our stock; dashboard price changes and product moves are written to Weimi. Owning the
  planogram (product per slot, price, name, image in our backend; kiosk catalog from config; Weimi
  only as a one-time import) is the next step, behind a mockup first.

## Wrong basket (2026-11-06)

- **Settlement weighs every basket on its own and never credits a heavier one.** An item moved
  from A to B is charged (correct: it left A) and B silently carries the wrong weight, so the
  next customer to take it from B pays for B's product. From fridge 0.70.11 `domain/Misplacement.kt`
  matches a basket's gain against what left the others: while the door is open the kiosk shows
  „<vara>“ er í röngu hólfi and marks the tile; at settlement the move travels as an anomaly
  (`reason: misplaced`, or `weight_added` when nothing taken matches) and backend 6.109.0 raises a
  `fridge_misplaced_item` warning (resolve = moved back). **The charge is never changed by it.**
- Live reads cover only the stocked span of each cabinet, so an item dropped into an empty basket
  past the last stocked one is caught at settlement, not on screen.

## Skins (2026-11-05)

- **The kiosk's look is a skin, chosen in the dashboard** (AG only): per operator in the operator's
  settings, per machine under Controls → Skin (the canary switch). Two exist: `classic` (cream,
  Cormorant, the fleet's look so far, the default) and `franklin` (the 2026 redesign: white, black
  hairlines, Libre Franklin, square corners, no brand line). The config carries `skin` and
  `skinSource`; the app applies it at the next poll, no restart. Coil 0.80.22+ and fridge 0.70.10+ (each app's `ui/theme/Skin.kt`, same
  structure; the fridge adds `SuccessText`, `Brick`, `BrickDeep`).
- **A skin is tokens, not a second UI.** `AppColors`, `AppFonts`, `AppTypography` and
  `AppShapes.rounded(r)` read from `LocalSkin`; the legacy colour names are roles (in Franklin
  "Bronze" is ink and "Cream" is white). Screen structure, timers, strings and the reader states are
  shared by both skins. When restyling a screen for Franklin, prefer the role tokens (`Accent`,
  `Advisory`, `Wall`, `WallDeep`, `TilePalette`) and keep classic looking as it did; a structural
  difference between the two is a flag on `Skin` (like `showBrandLine`), and the list of flags
  stays short.
- The redesign handover (Nov 2026) is applied step by step behind the Franklin switch: theme
  tokens (0.80.22), then status bar and grid tiles, payment and reader states, success and
  complaint, overlays, staff screens. Canary 62160480 first, one machine at a time.

## Complaints on coil machines (2026-11-10)

- **The complaint form is no longer offered on the thank-you screen by default.** Too many claims
  were fishing for a refund. From coil 0.80.25 the customer reaches it through "hafðu samband",
  which shows the last sale for ten minutes with "vara kom ekki út?". `complaintsEntry`
  (`success` | `contact` | `off`) is set per operator (operator settings) with a per-machine
  override (Controls, AG); the config carries the resolved value. Fridges are untouched.
- **Every coil sale carries evidence** (`lines[].vend`: slot, aisle, outcome, code, ms per motor
  run) and a hashed card reference (`cardRef`, SHA-256 of the reader's card_bin_hash and the last
  four; never the PAN) plus `cardLast4`. They live on `orders` and are snapshotted onto the
  complaint at ingest (`evidence`, `cardRef`). The complaint detail returns `evidenceDelivered`,
  `cardHistory` (30 days, same operator), `machineStats`. `POST /complaints/:id/refuse` sends the
  standard IS+EN reply and sets status `refused`. The drop sensor is NOT used (it misses items
  that pass through it and then nothing is charged), so "delivered" means the motor completed.
- Backend 6.112.0.
