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

## Setting up a new machine

- **Check `auto_time` first.** `settings get global auto_time` must be `1`. A wrong clock fails TLS
  silently: the machine reaches nothing while the screen looks perfectly healthy. It was `0` on
  62160479, and that failure has cost days on three other machines.
- **A power cut can put the clock back years.** 62160479 came back reading **19 May 2023** with
  `auto_time` off (2026-10-24) and sold nothing for two days. What the screen showed was a Weimi
  catalog failure, `SSLHandshakeException … Certum Trusted Network CA … insecure hash function` —
  which reads like Weimi's certificate and is not a reason to contact Weimi until a correct clock
  has been tried. (Not yet confirmed to clear once the clock is fixed.) Check the date in the
  pull-down shade first; it is reachable from the setup screen, where the clock long-press is not.
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

  Accepted on `62160484` (reads back `5555`) on 2026-10-23. **Unproven**: the board accepting the
  write is not the same as adbd honouring it at boot, and that can only be tested by a reboot. Do
  not spend a placed machine's reboot on the experiment — 62160484 will answer it for free the
  next time it restarts for its own reasons. If it holds, it is the answer to the unattended
  remote access problem the handovers open with.

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
