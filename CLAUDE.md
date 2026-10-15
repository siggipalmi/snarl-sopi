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

## This repo

- Bump `snarl-sopi-backend/package.json` version on every change; Health shows it.
- Check: `node --check` on changed `src/*.js`, and parse the `<script>` blocks of
  `public/index.html`.
- Never ship real fleet data (machine names, codes, prices) inside `index.html`; the
  dashboard gets everything from the backend, scoped to the signed-in user.
