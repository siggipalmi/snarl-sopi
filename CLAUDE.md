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
- Nothing in `src/weimi.js` can register a device. The writes are aisle and goods only, against a
  device that already exists.
- Check with `/api/v1/debug/weimi-device?deviceCode=X`, which uses the backend's own credentials
  rather than the app's. (Those `debug/weimi-*` routes have no auth middleware — worth fixing.)
- Fridges do not resolve identity through Weimi and are unaffected.

## Setting up a new machine

- **Check `auto_time` first.** `settings get global auto_time` must be `1`. A wrong clock fails TLS
  silently: the machine reaches nothing while the screen looks perfectly healthy. It was `0` on
  62160479, and that failure has cost days on three other machines.
- A device code **on the kiosk screen proves nothing** — it is cached local state. Confirm from the
  dashboard: a command leaving `pending`, or the key going `active`.
- Wireless-debugging uses a **new random port every reboot**, and reading it needs eyes on the
  screen. Front-load every adb step before the first reboot.
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
