# skraning.agvending.is

Lease registration, off Squarespace. The customer fills in the form, and a Google Docs
lease agreement is created from **"leigusamningur template"**.

```
browser ──▶ skraning Worker ──▶ D1 (every registration, with its step and last error)
               │
               ├─ fyrirtækjaskrá   (skattur-company-lookup Worker, checked again on submit)
               ├─ staðfangaskrá    (iceland-address-proxy Worker, checked again on submit)
               ├─ serials          (admin.agvending.is /api/v1/leases/claim, idempotent by registration id)
               ├─ login            (admin.agvending.is /api/v1/operators/provision, idempotent by kennitala)
               ├─ vísitala         (Hagstofa, cached 6 h)
               └─ ONE webhook ──▶ Zapier: Catch Hook ──▶ Create Document From Template ──▶ …
```

## Why the old flow missed some registrations

- **The Squarespace trigger polls.** Zapier checks for new form submissions on a timer, and field
  keys are hashes of the field labels, so renaming a label in Squarespace silently breaks the mapping.
- **The page script fought Squarespace.** It found fields by label text, re-ran on a 500 ms timer and
  could not change values at submit time without breaking the CAPTCHA. Company data came only from
  read-only inputs the browser filled in, so the Zap saw whatever the browser happened to send.
- **Nothing was idempotent.** One registration could create several documents and claim several
  machines. Stök Gulrót ehf. has three contracts created within three minutes on 5 Aug.
- **Nothing kept a record.** A failed Zap run left the registration only in Zapier's task history.

## What changed

- **Every registration is stored before anything else happens**, then moves through
  `received → claimed → ready → sent`. Each step is saved, so a failure is retried from the step
  where it stopped: every 5 minutes, up to 8 attempts, with backoff.

  **`sent` means the Zapier hook accepted the payload. It does not mean the contract exists.**
  Everything after the hook — the document, the signing request, Payday — happens inside Zapier,
  where this Worker has no visibility and nothing to retry. A Zap that errors on its third step
  leaves the registration sitting at `sent` looking finished. On 22 Oct 2026 one did exactly
  that, and the only sign was a Zap alert email. Turn on Zapier's error notifications; a row
  reading `sent` is not evidence that a customer got anything.
- **Fields are recomputed on the server.** The Worker gets company name, legal address and
  manager from fyrirtækjaskrá itself, and confirms the address against staðfangaskrá.
- **Exactly one machine is claimed per registration.** The claim carries the registration id, and
  the backend returns the same serials if the call is repeated.
- **No contract goes out without serial numbers.** If fewer machines are in stock than requested,
  the backend (v6.32.5) claims none and the registration waits, retrying, instead of reaching Zapier.
- **The lease always starts on the first of the coming month.** The form shows the date; the
  customer does not choose it.
- **The signer is collected for e-signing.** Who can sign comes from fyrirtækjaskrá: the
  framkvæmdastjóri and any prókúruhafi. With more than one, the customer picks from a list, and the
  server accepts only a person the registry lists at submit time. When the registry has nobody, name
  and kennitala are typed in. The form asks for the signer's email and mobile. The list needs the
  `signers` field from `skattur-company-lookup` (see `../skattur-company-lookup/SIGNERS.md`);
  without it the registry's single manager is used, as before.
- **The customer gets a login, with their machines in it.** "Tengiliður vegna reksturs" is the
  person who runs the machines day to day (name, email, phone; the signer unless ticked otherwise).
  Just before the Zap is called, the backend creates the operator for the company, emails that person
  an `operator_admin` invite to admin.agvending.is, and puts the claimed machines under the operator.
  A serial is the machine's device code: an existing machine is moved, a missing one is created
  offline until its kiosk connects. A machine already run by another customer's operator is left
  alone and reported. If the company already has an operator (same kennitala), its machines are
  linked but no invite is sent: anyone can type a kennitala into a public form, so extra users for an
  existing customer are added from the dashboard. A failed login step is recorded on the
  registration and never holds up the contract.
- **AG Vending hears about every registration.** The backend emails `LEASE_NOTIFY_TO` (default
  siggip@agvending.is) when a registration arrives, and again if one stops after its retries.
- **Duplicate submissions are collapsed.** Same kennitala, address, machines and start date within
  24 h returns the existing registration.
- **The Zap only copies fields.** Every template placeholder arrives already computed, with a key of
  the same name.

## One-time setup

### 1. Backend

Deploy `snarl-sopi-backend` v6.32.5. It adds `requestId` and `allOrNothing` to
`/api/v1/leases/claim`; calls without them behave exactly as before.

### 2. Zapier: point the existing Zap at a webhook

In the lease-agreement Zap:

1. **Replace the trigger.** Swap *Squarespace: New Form Submission* for
   *Webhooks by Zapier: Catch Hook*. Copy the hook URL.
2. **Delete steps the Worker now does:** the Webhooks POST to `/api/v1/leases/claim`, and any
   Formatter or Code steps that built the price, dates, machine description, vísitala or month.
3. **Google Docs: Create Document From Template.** Template: *leigusamningur template*.
   Document name: `skjal_titill`. Map each `{{placeholder}}` to the webhook field with the same name:

   | Template placeholder | Webhook field |
   |---|---|
   | `{{Nafn_Leigutaka}}` | `Nafn_Leigutaka` |
   | `{{Kennitala_Leigutaka}}` | `Kennitala_Leigutaka` |
   | `{{Logheimili_Leigutaka}}` | `Logheimili_Leigutaka` |
   | `{{Nafn_Framkvaemdastjora}}` | `Nafn_Framkvaemdastjora` |
   | `{{Kennitala_Framkvaemdastjora}}` | `Kennitala_Framkvaemdastjora` |
   | `{{Netfang_Samskipti}}` | `Netfang_Samskipti` |
   | `{{Simi}}` | `Simi` |
   | `{{hid_leigda}}` | `hid_leigda` |
   | `{{radnumer_sjalfsala}}` | `radnumer_sjalfsala` |
   | `{{radnumer_nayax}}` | `radnumer_nayax` |
   | `{{leigugjald}}` | `leigugjald` |
   | `{{upphaf_leigutima}}` | `upphaf_leigutima` |
   | `{{vnv}}` | `vnv` |
   | `{{manudur}}` | `manudur` |
   | `{{Heimilisfang_Stadfest}}` | `Heimilisfang_Stadfest` |
   | `{{undirritunardagur}}` | `undirritunardagur` |

4. **Remap the later steps** (signing, email, Payday, `/operators/provision`) to the webhook fields.
   Extra fields you can use: `skraning_id`, `kennitala` (digits only), `netfang`,
   `fjoldi_tvofaldur`, `fjoldi_einfaldur`, `fjoldi_skjar`, `leigugjald_kr` (a number), `upphaf_iso`,
   `athugasemdir` and `skrad`.

   For invoicing: `Netfang_Reikninga` is the address invoices go to. It is the one the customer gave
   under "Senda reikninga á annað netfang", otherwise the contact's email;
   `reikningar_serstakt_netfang` is `true` when they gave a separate one.

   For the e-sign step, the person who signs:

   | Field | Example |
   |---|---|
   | `Nafn_Undirritanda` | Júlíus Ingi Jónsson |
   | `Kennitala_Undirritanda` | 0101801234 (10 digits, no dash) |
   | `Netfang_Undirritanda` | julius@lavashow.com |
   | `Simi_Undirritanda` | 8237777 (digits, `+` kept for foreign numbers) |
   | `Hlutverk_Undirritanda` | Framkvæmdastjóri, Prókúruhafi, or both; empty when typed in |

   The operations contact (already given a login by the Worker, so the Zap does not need to call
   `/operators/provision`): `Nafn_Tengilids`, with `Netfang_Samskipti` and `Simi`.

Deploy the Worker (step 3), submit one test registration, then use it in the Zap editor as the
trigger's sample data so every field appears when you map.

### 3. Cloudflare

The database and its schema already exist, and `wrangler.toml` carries the real `database_id`.
Only the secrets are set by hand:

```sh
cd skraning-site
npx wrangler secret put ZAPIER_HOOK_URL      # from step 2
npx wrangler secret put LEASE_CLAIM_SECRET   # same value as on the backend
npx wrangler secret put ADMIN_TOKEN          # any long random string
npx wrangler secret put PROVISION_KEY        # same value as PROVISION_KEY on the backend (Railway)
npx wrangler deploy
```

Starting over on a different Cloudflare account is the only reason to run:

```sh
npx wrangler d1 create skraning          # paste the database_id it prints into wrangler.toml
npx wrangler d1 execute skraning --remote --file=schema.sql
```

**A deploy overwrites the Worker's remote configuration with this file.** If `wrangler deploy`
warns that the local and remote configurations differ, read the diff before answering: `+` is what
your file would apply and `-` is what is live now. Anything on the `-` side that you did not mean
to remove — a `database_id`, a service binding, a route — means `wrangler.toml` is behind
production. Answer **n**, fix the file, and deploy again. Answering yes to that prompt once would
have replaced the live D1 binding with a placeholder and stopped every registration being stored.

**The domain.** `routes` in `wrangler.toml` makes `skraning.agvending.is` a custom domain, so
`wrangler deploy` creates the DNS record and the certificate itself. Two requirements:

- **The agvending.is zone must be on the Cloudflare account you deploy from.**
- **No DNS record may already exist for that name.** *Before the first deploy*, open
  **agvending.is → DNS → Records** and delete any existing `skraning` record (A, AAAA or CNAME, for
  example one left over from Squarespace). Otherwise Cloudflare refuses to attach the domain and the
  deploy fails with an error about an existing DNS record.

To attach the domain by hand instead, use **Workers & Pages → skraning → Settings → Domains &
Routes → Add → Custom domain** and enter `skraning.agvending.is`. The same rule about existing
records applies.

**Check the vísitala before the first real registration.** Open `https://skraning.agvending.is/api/cpi`.
It shows the value and month it will put in the contract, and which Hagstofa series it chose.
It should match the latest *Vísitala neysluverðs* on hagstofa.is (694.6 for 2026M08 on the
Icelandic Lava Show contract). If it picks the wrong series, set `CPI_TABLE` to the right table. If
Hagstofa is down, set it by hand with `npx wrangler secret put CPI_OVERRIDE` and a value like
`694.6@2026M08` (delete that secret afterwards so it updates again).

**Optional bot protection.** Create a Turnstile widget, put its site key in `TURNSTILE_SITE_KEY` and
its secret in `TURNSTILE_SECRET`. Without them, the hidden honeypot field is the only bot check.

### 4. Switch over

When the new flow works end to end, deploy `agvending-site`. Its `_redirects` sends
`agvending.is/skraning` to the new form. That redirect only works once agvending.is itself is served
by the `agvending` Worker. While agvending.is is still on Squarespace, add the redirect there instead:
**Settings → Advanced → URL Mappings**, then `/skraning -> https://skraning.agvending.is 301`. Then turn off the Squarespace form or its Zap trigger, so
nothing arrives through the old path.

## Operating it

`ADMIN_TOKEN` is a Worker secret, so it lives on Cloudflare and not in your shell. From a fresh
terminal the variable is empty, which sends a bare `Bearer` and gets back `{"error":"unauthorized"}`
— the same answer you would get for a wrong token, so the message does not tell you which it is.
Put it in the shell first (`read -rs` keeps it out of your history; nothing echoes as you paste):

```sh
read -rs ADMIN_TOKEN && export ADMIN_TOKEN
```

Cloudflare will not show you a secret again once set. If the value is lost, replace it — nothing
else reads it, only `/api/admin/*` on this Worker:

```sh
ADMIN_TOKEN=$(openssl rand -base64 32 | tr -d '/+=' | cut -c1-40)
printf '%s' "$ADMIN_TOKEN" | npx wrangler secret put ADMIN_TOKEN
export ADMIN_TOKEN
printf '%s' "$ADMIN_TOKEN" | pbcopy    # into the password manager, never onto the screen
```

`npx wrangler secret list` shows the names of all four secrets without revealing any value, which
is how you check that a deploy left them intact.

```sh
T="Authorization: Bearer $ADMIN_TOKEN"
curl -H "$T" https://skraning.agvending.is/api/admin/submissions                 # newest 100
curl -H "$T" https://skraning.agvending.is/api/admin/submissions?status=failed
curl -H "$T" https://skraning.agvending.is/api/admin/submissions/skr_…           # full row + payload
curl -H "$T" -X POST https://skraning.agvending.is/api/admin/submissions/skr_…/retry
```

A `failed` row has stopped after 8 attempts. `last_error` names the step and the reason. Fix the
cause, then call `retry`: it resumes from that step and does not claim a second machine.
`lease claim 409 … insufficient_stock` means not enough machines were available: add or free units
in the admin dashboard and the registration goes through on its next attempt. The detail view has a `provision` field with the login step's result: `created: true` (invite
sent), `created: false` (the company already had an operator), `machines` (each serial and whether
it was linked, and why not), `ok: false` with the backend's answer
(for example a wrong `PROVISION_KEY`), or `null` when `PROVISION_KEY` was not set. `retry`
on a `sent` row sends the same payload to Zapier again, which is how you re-create a document.

Prices and contract wording for each machine type are in `MACHINES` at the top of `src/lib.js`.

## Tests

```sh
npm test   # contract fields, kennitala check digit, dates, vísitala parsing
```
