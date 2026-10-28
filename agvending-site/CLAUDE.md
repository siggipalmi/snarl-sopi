# agvending.is — notes for Claude

The public marketing site for AG Vending: a one-page Icelandic sales site whose only
conversion is "get in touch". Read the root `CLAUDE.md` too — its "Working with Siggi"
rules apply here.

Updated 28 Oct 2026, from the claude.ai Project handover of 25 Aug.

## Scope

- **Work only inside `agvending-site/` unless asked.** The same repo holds the live backend
  (`snarl-sopi-backend/`, Railway), both kiosk apps, and `skraning-site/` (lease
  registration, its own Worker). None of them is this site.
- Branch, PR, and merge your own PR once checks pass, as the root `CLAUDE.md` describes.
  **Merging to `main` deploys the live site** through Workers Builds within a minute or two,
  so the checks below are the gate.
- Ask before touching Cloudflare DNS or the Worker's dashboard settings. See "Must not break".

## Stack (fixed — do not change)

Fully static. Plain HTML/CSS/JS. No framework, no build step, no CMS, no npm dependencies.

- **Pages:** `public/index.html` (the whole site, ~42 KB) + `takk.html` + `404.html` + `500.html`
- **Host:** Cloudflare Worker `agvending` with static assets — NOT Pages, NOT Railway.
  Preview at `agvending.siggip.workers.dev`
- **Config:** `wrangler.toml`, `public/_headers`, `public/_redirects`, `robots.txt`, `sitemap.xml`
- **CSS:** hand-written, one inline `<style>` block
- **JS:** vanilla — FAQ accordion, logo marquee, form submit
- **Lang:** Icelandic, `lang="is"`. Keep files UTF-8; check for mojibake after any rewrite
- **Local preview:** `npx wrangler dev` from `agvending-site/`

`wrangler.toml` has **no `main` key on purpose**: with no Worker script every request is
served from the asset store, so nothing is billed. `name = "agvending"` must match the live
Worker — a different name deploys to a second, separate Worker.

## ⚠ Must not break

1. **`api.agvending.is` stays Cloudflare-proxied (orange cloud).** ~46 machines run Android 11
   with a frozen trust store. Railway once renewed onto a newer Let's Encrypt root they don't
   have and the whole fleet lost TLS.
2. **Mail records stay DNS-only (grey):** `MX`, `em3804`, `s1._domainkey`, `s2._domainkey`.
   Proxying one breaks authentication — strict providers bounced customer mail while Gmail still
   accepted it, so it looked intermittent for days.
3. **`admin.agvending.is` is the live operator dashboard.** A site deploy must never touch it
   (it can't — Railway's root dir is `snarl-sopi-backend`).

## Launch blockers (status 28 Oct)

1. **Photos — done (28 Oct).** All 7 in `public/assets/img/`, downloaded from the Squarespace
   CDN. The hero is the old site's Orkan station photo; `portrait-stefan.jpg` is the Hagaskóli
   crest, because the old site never had a photo of him.
2. **Logos — done with 16 (28 Oct).** The zip never reached the repo, so they were rebuilt from
   the Squarespace originals (159 kB). Orkan and Macron are white marks on transparent for their
   `ag-inv` tiles, so Macron is `macron.png` (a JPEG can't be transparent). Nordic Hostel was on
   no Squarespace page, so its tile was dropped; Siggi will add it and more logos once there is a
   staging site. The names are load-bearing: the markup references them literally, with
   per-logo `mul`/`inv` flags.
3. **Folders full — done (28 Oct).** Both `.gitkeep` files and the temporary missing-image
   script are gone, so a missing image now shows as a broken icon.
4. **Contact form endpoint.** The form POSTs to `https://admin.agvending.is/api/tilbod`. As of
   25 Aug it did not exist and a code search on 28 Oct found no `tilbod` route. Confirm before DNS
   cutover, or every enquiry is silently lost. It must accept `nafn`, `netfang`, `simi`,
   `stadur`, `skilabod`, reject the request when `bot-field` is non-empty, and send through
   SendGrid (already a backend dependency). CORS is `*`. Building it is backend work — follow
   the root `CLAUDE.md` for that.
5. **Worker build root.** `agvending.siggip.workers.dev` once served a since-deleted root-level
   placeholder, which suggests the Builds root directory was the repo root. Check
   Settings → Build: root directory `agvending-site`, build command empty.
6. **DNS.** Apex and `www` still point at Squarespace. Move them only after the site is
   verified on workers.dev.
7. **Cancel Squarespace last** — after DNS propagates, the site is confirmed live, and the built
   HTML contains no `squarespace` reference.

## Design brief

**Priority: Products → Pricing → FAQ.** The old site was "unfocused and cluttered". If a change
makes any of those three harder to find, it's wrong.

- **Price lives on the product card.** Product and price in one scroll — never split them again.
- **The partner logo rail stays.** An earlier pass deleted it; Siggi: *"the partner logo carousel
  gives us gravitas in the market"*. Mono, colour on hover of the single tile. Honours
  `prefers-reduced-motion`.
- **Density is fine where it earns its place.** The spec blocks on product cards are dense on
  purpose — operators care about dimensions and weight. He asked for focus, not minimalism.
- **No CMS.** Deliberate. He edits copy rarely and is happy to have changes made for him.

### Restyle direction (Oct 2026)

After a MoMA visit Siggi wants the shared look (site, dashboard, kiosks) less boring: flat
saturated colour blocks and bold grotesque type. **For this site the full-colour version is too
heavy — colour is used as accents.** He approved the accent-style website mockup. Check whether it
has been implemented before assuming the tokens below are current, and show a mockup before any
restyle work.

### Tokens (as built, pre-restyle)

```css
--cream:#FAF7F2; --cream-deep:#F0E8DA; --cream-shadow:#E8DFD0;
--ink:#1A1A1A; --ink-soft:#3A3A3A;
--bronze:#8B6B3E; --bronze-light:#B8946B; --bronze-bg:#F7F0E6;
--clay:#D4CCBE; --line:#E8E2D8; --muted:#8A8275; --muted-2:#6B6B6B;
--alert:#B8471F; --alert-bg:#FAEEE9; --success:#4A6B2E; --success-bg:#EBF2E6;
--serif:'Cormorant Garamond',Georgia,serif; --sans:'Geist',system-ui,sans-serif;
--mono:'Geist Mono',monospace; --r:10px; --rlg:16px; --rsm:6px;
```

Sand `#E8DFD0` page, cream `#FAF7F2` cards — warm paper, never white. Borders always
`0.5px solid #E8E2D8`; don't thicken the hairline. Shadow `0 1px 3px rgba(0,0,0,.04)`, cards only.
Flex/grid with `gap`, never margin-spaced siblings. Cormorant Garamond italic 500 for h1–h3 and
prices only; Geist body; Geist Mono uppercase 9–12px for labels/specs.
Breakpoints: 1120 · 1000 · 960 · 760 · 680.

**Three deliberate deviations from the dashboard CSS — keep them.** Italic serif only on h1–h3 and
prices; type sizes raised; bronze (or its successor accent) only as a signal — links, FAQ toggle,
price pills.

## Content facts (load-bearing)

- Rent from **40.000 kr/mán + VSK** (55.000 for the double smart machine)
- **0% of sales** — fixed fee only. The strongest differentiator; it appears in the hero stats,
  the pricing headline and the FAQ. Keep all three.
- Free delivery and setup in the capital area
- Included: machine, Nayax vPOS touch reader, web admin, maintenance, warranty
- Tenant provides: power, internet, a Teya acquiring agreement (AG assists)
- Open-ended term; 1 month notice for the first three months, 3 months after
- AG Vending ehf. · kt. 590922-0800 · agvending@agvending.is

## Deliberate deviations from the design source — keep

1. **Apex, not www.** `canonical`, `og:url`, `og:image`, the `LocalBusiness` JSON-LD `url`,
   `robots.txt` and `sitemap.xml` all use `https://agvending.is/`. Change all together or none.
2. **Form posts via fetch**, redirects to `/takk` on success, inline fallback with the mailto on
   failure.
3. **`/takk`, not `/takk.html`** — matches `html_handling = "auto-trailing-slash"`.

## `sa.png` is Skautafélag Akureyrar

Not Samtök atvinnulífsins — the crest is a script SA monogram and a skater. Confirmed by Siggi.
Never describe the rail as carrying an industry body. The source is only 131×177 and renders soft
at 2×; a higher-resolution crest is worth asking for.

## Logo traps (if reprocessing)

- `ir.gif` has palette transparency; composite onto white (its `mul` flag expects that) — a naive
  RGB convert renders a solid grey tile.
- `nordic-hostel.gif` (not on the rail yet) was a 100-frame 13.3 MB animation; ship frame 0 only.
  A moving logo inside a moving marquee is noise.
- Cap at 600px longest edge; the tile content box is ~124×58 CSS px.

## Config

- `_headers`: security headers on `/*`; 1-year immutable on `/assets/*` — **rename a file when
  replacing it**, or browsers keep the old one; `max-age=0, must-revalidate` on `/` and `/*.html`.
- `_redirects`: legacy Squarespace 301s with and without trailing slash — `/contact` →
  `/#hafa-samband`, `/snjallsjalfsali` and `/sjlfsali-me-snertiskj` → `/#vorur` (that spelling
  is a real indexed URL); `/skraning` → `https://skraning.agvending.is/`.

## Checks before merging a change to `public/`

- Valid UTF-8, no mojibake; balanced tags; both JSON-LD blocks parse
- All in-page anchors and `aria-controls` targets resolve
- The `"` in the 55" machine's `alt` stays escaped as `&quot;`
- No horizontal overflow at 1440, 1000 and 390px
- FAQ opens single-item with the first open
- No `squarespace` anywhere in the built HTML
- Look at it in `wrangler dev` before merging, and on workers.dev after

## Open decisions (Siggi's)

- New machine photography: studio cut-outs on white for cards (300px well,
  `object-fit: contain`) plus in-situ shots for the hero
- Kiosk flow video: 8–12s silent MP4 loop composited into the machine screens — show the
  copy/storyboard for approval before producing it
- `/about` and other Squarespace pages: port, fold into the homepage, or drop with a 301
