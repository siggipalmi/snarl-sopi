# API Contract Addendum — Sales Reporting

**Version:** 0.2 (draft, adds sales endpoint)
**Last updated:** 2026-05-22
**Status:** Proposed by backend chat — pending kiosk chat review

This document adds a single new endpoint to the existing Kiosk ↔ Admin
Backend API Contract v0.1. Everything in v0.1 still applies. This only
adds new behavior; no existing behavior changes.

---

## Motivation

Direct Weimi API access from the operator backend is blocked
(`host_not_allowed` from Weimi's WAF). The kiosk app is the only client
that can talk to Weimi reliably, because it sends requests from a
registered Android device.

Rather than treating sales as a query the operator backend pulls from
Weimi, we treat sales as **events the kiosk pushes to the backend** at
the moment they happen. This has two advantages:

1. Real-time updates — the operator dashboard sees sales seconds after
   they complete, not when a polling cycle finishes
2. Works regardless of Weimi reachability — the backend doesn't depend
   on Weimi at all for sales data

Only the **24 VM-WM55DL kiosks** running our app will report sales.
The 9 non-kiosk machines (5× GR-WM22Z680, 4× GR-WM22Z1260 — Icelandair
units) don't run our app and will show "n/a" for sales in the dashboard.

---

## New endpoint

### POST /api/v1/machines/:deviceCode/sales

Fired by the kiosk after a successful (or failed/refunded) dispense.

**Auth:** `X-Machine-Key` (same as all kiosk-facing endpoints — contract section 2.1)

**Path parameter:** `deviceCode` must match the key's bound device.

**Body (single sale):**
```json
{
  "tradeNo":     "SS3f9a1b2c4d5e6f",
  "goodsId":     "884ab184f243b26cac38bc355e867bd7",
  "productName": "corny big súkkulaði",
  "amountKr":    299,
  "timestamp":   1779151921000,
  "status":      1
}
```

**Body (batch — for offline queue flush):**
```json
[
  { "tradeNo": "SS...", "amountKr": 299, "timestamp": ..., "status": 1, ... },
  { "tradeNo": "SS...", "amountKr": 499, "timestamp": ..., "status": 1, ... }
]
```

### Field reference

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `tradeNo` | string | yes | Unique transaction ID — use the same one Weimi assigns. The backend uses this for deduplication, so the kiosk can safely retry a failed POST without creating duplicates. |
| `goodsId` | string | no | Weimi product ID. Lets the operator dashboard cross-reference with the catalog. |
| `productName` | string | no | Human-readable product name at sale time. Stored as the historical product name even if the product is later renamed. |
| `amountKr` | number | yes | Amount charged in ISK (whole kroner). |
| `timestamp` | number | yes | UTC epoch milliseconds when the sale completed. The backend uses this for grouping by day (00:00 UTC). |
| `status` | int | yes | `1` = success, `2` = failed, `3` = refunded. Only `1` counts toward revenue stats. |

### Response (200 OK)
```json
{
  "ok":   true,
  "data": { "accepted": 1, "duplicates": 0, "total": 1 }
}
```

For batches, `accepted + duplicates = total`. The kiosk should clear
its offline queue based on this — both accepted and duplicate records
are safe to remove from the queue (the backend has them either way).

### Failure modes

| Code | Meaning | Kiosk action |
|------|---------|--------------|
| `400` | Validation error (missing tradeNo, wrong status code, etc.) | Don't retry — log and drop the record. The error response includes which field failed. |
| `401` | Invalid/revoked machine key | Return to setup phase. Same behavior as contract section 2.3. |
| `404` | Device not registered | Return to setup phase. |
| `5xx` / network | Backend temporarily unavailable | Queue locally and retry later. The backend is idempotent on `tradeNo`, so retries are always safe. |

---

## Behavior contracts

### When to POST

The kiosk POSTs **once per sale**, immediately after the sale completes
(dispense confirmed, payment confirmed). Don't wait for a batch window
under normal operation — real-time is the whole point.

### Offline queue

If the kiosk is offline at sale time, or the backend POST fails:

1. Queue the record locally (DataStore)
2. Retry with exponential backoff: 30s, 2m, 10m, 30m, then every hour
3. When the queue has >1 record on a successful retry, send as batch
4. Clear the queue based on the response's `accepted + duplicates` count

The kiosk should retain queued records across app restarts and OS
reboots. A sale that never makes it to the backend is lost analytics
data and could affect operator decisions on restocking.

### What NOT to include

- **No customer data** — the contract is strict about this. No card
  digits, no PII, no IP addresses. Just the sale event itself.
- **No raw payment provider response** — if there's debugging value
  in the raw Nayax response or similar, that goes in a separate error
  reporting endpoint (deferred from v0.1, contract section 7).

### Status mapping

The kiosk receives sale outcomes from the hardware/payment stack in
various forms. Map them as follows when constructing the POST:

- Dispense succeeded AND payment captured → `status: 1`
- Payment captured but dispense failed (motor stuck, sensor mismatch) → `status: 2`
- Payment refunded (auto-refund on dispense failure) → `status: 3`
- Payment failed before dispense attempted → don't POST at all (this isn't a sale)

---

## Operator dashboard impact

With sales reporting in place, the dashboard's "today sales" column
shows:

- For VM-WM55DL machines (kiosk model): real revenue since 00:00 UTC, or `0 kr` if no sales yet today
- For non-kiosk machines (GR-WM22Z680, GR-WM22Z1260): `n/a` permanently, since they don't run our app
- For offline kiosks: `—`

The `/api/v1/orders/today` summary endpoint already exists and is fed
by this new sales endpoint — no further changes needed on the operator
side.

---

*Changes to this document must be agreed in both chats. Once approved,
this addendum's content will be merged into the main contract as v0.2.*
