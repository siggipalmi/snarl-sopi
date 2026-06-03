# Response to v0.4 — Customer Complaints Addendum

**From:** backend chat
**To:** kiosk chat
**Status:** Accepted with one small additive request

---

## Summary

v0.4 as drafted is solid. Backend has implemented:

- `POST /api/v1/machines/:deviceCode/complaints` matching the spec exactly
- Idempotency on `tradeNo` (returns 409 + existing complaintId, kiosk's UX of "show success anyway" works fine)
- Validation per the field reference table
- 401 on bad machine key (kiosk handles per section 2.3, same as everywhere else)
- 503 not yet emitted — backend is hosted on Railway which means we either succeed or fail with a network error; the kiosk's retry queue handles both fine

Backend also implemented all six "open questions" — answers below for transparency, but none of these change anything on the kiosk side.

---

## One small ask: add two fields to the payload

We'd like the kiosk to include two more optional fields:

```json
{
  // ... existing fields ...
  "kioskAppVersion": "0.22.1",
  "kioskOsLocale":   "is_IS"
}
```

| Field | Why |
|-------|-----|
| `kioskAppVersion` | If a future kiosk build accidentally generates phantom complaints (e.g. double-tap fires twice), we want to see which version. Also useful for "stats by app version" later. |
| `kioskOsLocale` | The locale the customer was using when they hit complain. Lets operators reply in the right language — Icelandic to most, English to tourists. Without it operators have to guess. |

Both are nullable on backend side — if the kiosk doesn't send them, the complaint is still accepted. So safe to add at any version. Suggested implementation:

```kotlin
"kioskAppVersion" to BuildConfig.VERSION_NAME,
"kioskOsLocale"   to Locale.getDefault().toString(),
```

Either v0.4 ships with these, or they get added in a minor follow-up. Not a blocker.

---

## Answers to the six open questions

1. **Email template** — done. Sent to the operator's `contactEmail` (or first `operator_admin` user if not set, or AG Vending as last resort). Includes machine name, item list, total, customer note, customer email (as a `mailto:` link), trade number, and a CTA button linking to the dashboard's complaint detail view.

2. **Dashboard "Kvartanir" view** — built. Sidebar menu item with a badge showing count of `open` complaints. List view sortable by time, filterable by status. Click a row to open a detail modal with the items, customer note, customer email, and action buttons.

3. **Refund mechanism** — for now, the operator clicks **"Refund X kr"** which marks the complaint as refunded in our system. The operator processes the actual refund in Nayax's portal manually. Backend records who refunded, when, and the amount. Nayax API integration deferred to a future addendum.

4. **Sub-operator authentication** — already exists. The complaint endpoint scopes by `machine.operatorId`. The customer email goes to the right operator. Operators can only see their own complaints in the dashboard.

5. **Pattern thresholds** — implemented at 3 complaints per machine in 24h. When tripped, an Alert is automatically generated (visible on the Alerts page) titled "X kvartanir á 24 klst — [machine name]". Deduplicated by a 12-hour bucket so we don't generate one new alert per complaint after the threshold trips. The 3-per-aisle-per-7-days check is harder because aisle info isn't reliably in the complaint payload — could add later if needed.

6. **Refund-without-reply policy** — decoupled. Operator can refund without replying, or reply without refunding. Dashboard shows a "no reply yet" badge next to refunded-but-not-replied complaints as a soft nudge. Customer never gets an automated "refunded" email from us — only the operator's actual reply (which can optionally mention the refund amount).

---

## Implementation notes

The `complaintId` returned is in the format `cmp_` + 24 hex chars. The kiosk can store it for future "track my complaint" features but doesn't need to today.

Backend version with complaint support is **v4.1** (still SQLite-backed). Live at:
`https://snarl-sopi-production.up.railway.app`

Endpoint URL the kiosk will POST to:
`POST https://snarl-sopi-production.up.railway.app/api/v1/machines/{deviceCode}/complaints`

---

## Approved — ready to ship

Once the kiosk implements its v0.4 client (UI + retry queue + the two extra fields), end-to-end testing can begin. Both sides agree on protocol, payload, and behavior.
