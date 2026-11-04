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

- **Pages:** `public/index.html` (the front page) + `kerfid.html` (the web admin, /kerfid) +
  `about.html` (/about, "Um AG Vending ehf.", linked small from every footer) +
  `personuvernd.html` (/personuvernd, the privacy notice) + `takk.html` + `404.html` + `500.html`
- **`kerfid.html` and `about.html` share the front page's layout by copy:** its `<head>` style block (theme
  sections 1–18), header and footer are `index.html`'s, with the in-page links pointing back to
  `/#…`; only its section 19 and `<main>` are its own. Change a shared part in both files.
  It replaced the backend's `admin.agvending.is/features.html`, which now 301s here (6.106.9).
- **Live on agvending.is and www since 2026-11-03** (Worker custom domains; Squarespace's A
  records and www CNAME deleted; the zone export from before the move is in the session record).
- **Cookie consent and the Meta Pixel (4 Nov):** `public/consent.js`, loaded `defer` on every page,
  and a byte-identical copy in `skraning-site/public/consent.js`. Nothing that tracks loads before
  "Samþykkja": the answer is the cookie `ag_consent` on `.agvending.is` (one answer covers both
  sites, 6 months), only "granted" loads Meta's script, a later "Hafna" revokes and deletes `_fbp`/
  `_fbc`, and Meta's `<noscript>` image is left out on purpose (it fires without asking). Pages fire
  events with `agTrack(name)`: `Contact` on /takk, `Lead` on a finished skraning registration.
  **Any new tracker goes through consent.js, is named in the banner and on /personuvernd, and bumps
  `VERSION`** so everyone is asked again. "Vafrakökur" in every footer (`data-consent-open`)
  reopens the choice.
- **Fonts are served from the site** (`assets/fonts/`, Libre Franklin as one variable woff2 per
  character set), never from Google: loading them from Google sends every visitor's IP there.
- **/personuvernd states facts that must stay true:** the processors (Cloudflare, SendGrid,
  Railway, Google Workspace, Zapier, Payday, Meta) and the retention periods. A new service that
  sees personal data, or a change in how long anything is kept, changes that page too.
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
   the Squarespace originals (159 kB). Orkan and Macron are coloured marks on transparent
   (`orkan-mark.png`, `macron-mark.png`) so they show on the white page. Nordic Hostel was on
   no Squarespace page, so its tile was dropped; Siggi will add it and more logos once there is a
   staging site. The names are load-bearing: the markup references them literally, with
   the per-logo `ag-mul` flag.
3. **Folders full — done (28 Oct).** Both `.gitkeep` files and the temporary missing-image
   script are gone, so a missing image now shows as a broken icon.
4. **Contact form endpoint — built (backend 6.97.0, 2 Nov).** The form posts JSON to
   `https://admin.agvending.is/api/v1/site-enquiry` (`handleSiteEnquiry` in
   `snarl-sopi-backend/src/router.js`, fields nafn, netfang, simi, taeki, stadur, skilabod), which
   mails it as plain text to agvending@agvending.is
   (`SITE_ENQUIRY_TO` overrides) with the customer as reply-to. It answers 200 only once SendGrid
   has taken the mail, so a failure shows the mailto fallback instead of /takk. Honeypot
   `bot-field`; rate limit shared with the demo form (3/h per IP, 30/h total). Send one real test
   enquiry before DNS cutover. **Done 2 Nov: Siggi's test arrived in the inbox.**
   `taeki` is the machine-type dropdown. Since 3 Nov "Leigja þetta tæki" goes to skraning with the
   machine chosen (`?tvofaldur=1`, `?einfaldur=1`, `?skjar=1`, keys from `skraning-site/src/lib.js`);
   only the custom-machine link still pre-selects a dropdown option (`data-taeki`).
5. **Worker build root — fixed (28 Oct).** Builds failed because Root directory was `/`, where
   there is no `wrangler.toml`. Now `/agvending-site`; merging to `main` deploys (first good
   build 28 Oct 15:55 UTC). Include paths are still `*`, so every commit to the repo rebuilds the
   site; narrow them once preview builds are proven.
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

### Theme: "colour as accent" (Oct 2026)

After a MoMA visit Siggi wanted the shared look (site, dashboard, kiosks) less boring: flat
saturated colour and bold grotesque type. **For this site colour is an accent only**, never a
filled area. Siggi supplied the theme CSS; it is the inline `<style>` in `index.html`, sections
1–17 as delivered (minus its legacy-alias block) plus **section 18, the site addendum**, for
things the page has that the theme didn't cover. `takk`/`404`/`500` carry a subset (1, 3, 5, 7, 16).

- White page, `#111` type and 1px black rules; `--wall #F3F0EB` for the pricing band, image wells
  and form fields. The only dark areas are the testimonial band and the footer.
- The logo is `assets/img/logo-ag-vending.svg` (Siggi's render, 2 Nov), black; the footer turns it
  white with a CSS filter. The favicons are the dashboard's own: `/favicon_light.png` and `/favicon_dark.png` (copied
  from `snarl-sopi-backend/public/`), chosen by the visitor's light/dark mode.
- One typeface, Libre Franklin (500–900). No serif, no italics. Square corners, no shadows, no
  gradients. Black text on every colour.
- Palette, accents only: yellow `--accent` (kicker squares, the one highlighted word, link
  underlines, open FAQ sign), plus pink/sky/teal/salmon bars on stats, product cards and the
  testimonial band, green for "included" ticks, magenta for form errors.
- **One `.highlight` word per page** ("restina" in the hero).
- Partner rail: logos sit straight on white, mono at rest, colour on hover of the single tile.
  `ag-mul` goes on the **tile** for logos on a white rectangle. White marks vanish here, so
  Orkan and Macron ship as coloured marks: `orkan-mark.png` (Orkan magenta), `macron-mark.png`.
- Breakpoints: 1000 · 760 · 680.
- Show a mockup (screenshots of the branch's preview) before any further restyle work.

## Content facts (load-bearing)

- Rent from **40.000 kr/mán + VSK** (55.000 for the double smart machine)
- **0% of sales** — fixed fee only. The strongest differentiator; it appears in the hero stats,
  the pricing headline and the FAQ. Keep all three.
- Free delivery and setup in the capital area
- **Never "tilboð" (an offer/quote).** AG Vending has fixed prices; calls to action say "Hafðu
  samband" or "Leigja þetta tæki". "Tilboð" on the page means promotions an operator sets up in the
  web admin, which is fine.
- **Posi service fee goes to Tæknivit**, Nayax's service provider in Iceland, paid by the tenant on
  top of the rent (Siggi, 2 Nov). It appears in "Þú leggur til", the fine print and the first FAQ
  answer (plus its JSON-LD copy). So the hero never says "ekkert annað".
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

## Adding a partner logo

1. Put the file in `public/assets/logos/`: PNG (transparent if you have it), longest edge ≤600px,
   a lowercase name. A white or very light logo needs a dark version — the rail is on white.
2. Add **one line** to either row of the rail in `public/index.html` (two rows, below pricing;
   keep them **equal**, and the total a multiple of 14 is tidiest: with reduced motion the rail
   stands still as one grid of 7 / 4 / 2 columns), copying a neighbour:
   `<div class="logo-tile"><img src="assets/logos/NAME.png" alt="Name" title="Name" loading="lazy" decoding="async" /></div>`
   Add `ag-mul` to the tile's class when the logo sits on a white box. The looping copy is made by
   script, so there is no second line to add.
3. Do it on a branch: Workers Builds gives the branch its own preview URL to check before merging.
   To replace a logo, give the new file a new name — `/assets` is cached for a year.

## Logo traps (if reprocessing)

- `ir.gif` has palette transparency; composite onto white (its `mul` flag expects that) — a naive
  RGB convert renders a solid grey tile.
- Logos on a dark background get the background keyed out and the mark recoloured, never a dark
  box on the white rail: `nordic-hostel.png` (olive), `oddsson.png` (navy, wordmark only),
  `lava-show.png` and `thors-power-gym.png` (ink), `orkan-mark.png`, `macron-mark.png`.
- Tækniskólinn and Airport Associates came off the rail on 2 Nov (Siggi). Goa is waiting for a
  usable file: the `.ai` sent was saved without PDF content.
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
- ~~`/about` and other Squarespace pages~~ — decided 3 Nov: `/about` ported to the site at the
  same address (no redirect needed); the footer links it as "Um AG Vending ehf.".
