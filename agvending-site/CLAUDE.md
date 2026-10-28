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
   the Squarespace originals (159 kB). Orkan and Macron are coloured marks on transparent
   (`orkan-mark.png`, `macron-mark.png`) so they show on the white page. Nordic Hostel was on
   no Squarespace page, so its tile was dropped; Siggi will add it and more logos once there is a
   staging site. The names are load-bearing: the markup references them literally, with
   the per-logo `ag-mul` flag.
3. **Folders full — done (28 Oct).** Both `.gitkeep` files and the temporary missing-image
   script are gone, so a missing image now shows as a broken icon.
4. **Contact form endpoint.** The form POSTs to `https://admin.agvending.is/api/tilbod`. As of
   25 Aug it did not exist and a code search on 28 Oct found no `tilbod` route. Confirm before DNS
   cutover, or every enquiry is silently lost. It must accept `nafn`, `netfang`, `simi`,
   `stadur`, `skilabod`, reject the request when `bot-field` is non-empty, and send through
   SendGrid (already a backend dependency). CORS is `*`. Building it is backend work — follow
   the root `CLAUDE.md` for that.
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
