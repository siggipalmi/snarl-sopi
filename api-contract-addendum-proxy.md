# API Contract Addendum — Weimi Proxy via Kiosk

**Version:** 0.3 (draft)
**Last updated:** 2026-05-22
**Status:** Proposed by backend chat — pending kiosk chat review

This adds a WebSocket-based proxy channel from kiosk to backend. The kiosk
acts as a passthrough for Weimi API calls so the backend can fetch live
device status and inventory data, which it otherwise cannot do.

This is additive to the existing contract — nothing in v0.1 or the v0.2
sales addendum changes.

---

## Motivation

Weimi's WAF returns `403 host_not_allowed` for direct API calls from the
backend (Railway IP, has been verified). The Android kiosk app already
talks to Weimi successfully — Weimi accepts requests from registered
Android clients, likely via TLS fingerprinting or similar. Rather than
fighting their WAF, we proxy the small number of operator backend Weimi
calls through any one of the connected kiosks.

```
Operator Dashboard           Weimi API
       │                         ▲
       │ REST                    │ HTTPS (allowed)
       ▼                         │
Railway Backend ◄────────────────┤
       ▲          WebSocket       │
       │       (proxy channel)   │
       └─►  Kiosk app (any one online)
```

The same WebSocket is used for all proxying. A request from the backend
takes about 200–500ms round-trip when a kiosk is online.

---

## Connection setup

### Endpoint
```
wss://snarl-sopi-production.up.railway.app/proxy
  ?deviceCode={deviceCode}
  &machineKey={machineKey}
```

### Authentication

Auth is via query string (browsers can't set custom headers on WebSocket
upgrades, but kiosks can — we use query string for consistency).

- `deviceCode` — the kiosk's own device code (e.g. `62160487`)
- `machineKey` — the `mk_live_...` key from the provisioning flow (contract
  section 2.2). Same key, no separate auth needed.

If either is missing or invalid, the upgrade is rejected:
- `400` — missing `deviceCode` or `machineKey`
- `401` — `machineKey` is invalid, revoked, or doesn't match the device code

When the kiosk receives a 401 from the WebSocket upgrade, it should treat
it the same as a 401 from any other endpoint (contract section 2.3) — clear
the saved key and return to the setup phase.

### Lifecycle

1. **At app start**, after the kiosk completes provisioning and fetches its
   first config successfully, open the WebSocket.
2. **Keep it open indefinitely.** No disconnect on screen-off, on idle, or
   on phase transitions.
3. **Reconnect with exponential backoff** if the connection drops:
   1s → 2s → 5s → 15s → 60s → 60s → 60s ...
   Reset the backoff on every successful connection.
4. **Manual reconnect on demand** — diagnostics screen should have a button
   to force reconnect.

### Keepalive

The backend sends `{"type":"ping"}` every 25 seconds. The kiosk responds
with `{"type":"pong"}`. If the kiosk sees no ping for 60 seconds, it should
close and reconnect (network probably dropped).

The kiosk should also send `{"type":"ping"}` periodically when idle so it
notices a dead connection quickly.

---

## Message protocol

All messages are JSON, UTF-8, one message per WebSocket frame.

### Request from backend → kiosk

```json
{
  "id":     "550e8400-e29b-41d4-a716-446655440000",
  "action": "deviceProfile" | "deviceInfo" | "queryOrders",
  "params": { ... action-specific ... }
}
```

| Field | Notes |
|-------|-------|
| `id` | UUID v4 the kiosk must echo back in the response. |
| `action` | One of three Weimi endpoints — see below. |
| `params` | Same shape as the Weimi API's own parameters. |

### Response from kiosk → backend

```json
{
  "id":   "550e8400-e29b-41d4-a716-446655440000",
  "ok":   true,
  "data": { ... Weimi response body's `data` field ... }
}
```

Or on error:
```json
{
  "id":    "550e8400-e29b-41d4-a716-446655440000",
  "ok":    false,
  "error": "Network error: timeout"
}
```

The kiosk has 30 seconds to respond. If it doesn't, the backend gives up
and returns an error to whoever asked. The kiosk should still try to deliver
the response — late responses get dropped, no harm done.

---

## Supported actions

The kiosk uses its existing `WeimiHttp` / `ApiSignGenerator` — no new
Weimi integration code, just forwarding.

### `deviceProfile`

Forwards to: `GET /ext/device-profile`

**Params:** `{ "deviceCodes": ["62160487", "62160012", ...] }`

The kiosk should:
1. Join the array with commas: `62160487,62160012`
2. Add as a query parameter to the Weimi URL: `?deviceCodes=62160487,62160012`
3. Sign the request as usual
4. Return the entire `data` field from the Weimi response

**Returned `data` shape (passthrough from Weimi):**
```json
{
  "list": [
    { "deviceCode": "62160487", "isOnline": true, "isRunning": true, "totalCurrStock": 91, ... },
    ...
  ]
}
```

### `deviceInfo`

Forwards to: `GET /ext/device-info`

**Params:** `{ "deviceCode": "62160487" }`

**Returned `data`:** the first (only) element from Weimi's `data` array —
the full cabinet/layer/aisle layout. The backend pulls it apart on its end.

### `queryOrders`

Forwards to: `POST /ext/query-order-list`

**Params:**
```json
{
  "current":    1,           // page number
  "size":       50,
  "deviceCode": "62160487",  // optional
  "startDate":  "2026-05-22 00:00:00",  // optional
  "endDate":    "2026-05-22 23:59:59"   // optional
}
```

The kiosk should:
1. Strip out any null/undefined fields from `params`
2. Sign with the canonical JSON of the remaining params
3. POST that JSON body to Weimi
4. Return the `data` field

**Returned `data`:**
```json
{
  "records": [
    { "tradeNo": "...", "deviceCode": "...", "totalAmount": 29900, "status": 1, "createTime": 1779151921000, ... },
    ...
  ],
  "current": 1,
  "size":    50,
  "total":   123,
  "pages":   3
}
```

---

## Implementation notes for the kiosk

### Forwarding pattern

Roughly:

```kotlin
suspend fun handleProxyRequest(message: ProxyMessage) {
  try {
    val data = when (message.action) {
      "deviceProfile" -> weimiHttp.get("/ext/device-profile", message.params)
      "deviceInfo"    -> weimiHttp.get("/ext/device-info",    message.params)
      "queryOrders"   -> weimiHttp.post("/ext/query-order-list", message.params)
      else            -> throw IllegalArgumentException("unknown action")
    }
    socket.send(ProxyResponse(message.id, ok = true, data = data))
  } catch (e: Exception) {
    socket.send(ProxyResponse(message.id, ok = false, error = e.message))
  }
}
```

Reuse the existing OkHttp client, signing, etc. No duplication.

### Library choice

The standard Android WebSocket library is OkHttp's built-in WebSocket
support (`OkHttpClient.newWebSocket(...)`). Use that — no new dependencies.

### Thread safety

WebSocket callbacks come in on OkHttp's dispatch thread. Bridge to the
existing coroutine scope before doing Weimi work, so request handling
doesn't block ping/pong handling.

### Backpressure

If for some reason the kiosk is overwhelmed (multiple concurrent requests
arriving while one is still in flight), process them sequentially via a
single-threaded coroutine context. The backend won't send more than a few
per second in normal operation; no need for parallelism.

### Connection state in the UI

The diagnostics screen should show:
- WebSocket connection status (connected / connecting / disconnected)
- Last successful ping timestamp
- Count of requests proxied since app start

Customer-facing UI is unaffected. The proxy is invisible to the customer.

---

## What's NOT in this contract (yet)

- **Sending data the other way** (kiosk → backend events beyond the
  existing sales POST). The proxy is request/response only for now.
- **Cross-kiosk routing.** The backend picks any connected kiosk for any
  request. It does NOT route "give me device-info for 62160487" to the
  specific kiosk with that device code — any kiosk can answer any question
  since Weimi accepts the request from any registered client.
- **Push notifications from backend to kiosk** for config changes. Currently
  the kiosk polls `/config` every 15 min (contract section 4.1). When we
  want real-time config push, we can add a new message type on this same
  WebSocket. Deferred.

---

## Open questions

1. **Should the kiosk also send sales over the WebSocket** instead of HTTP
   POST? Probably not — HTTP POST is simpler, has clear retry semantics,
   and the WebSocket might be down when a sale completes. Keep them
   separate.
2. **What happens if all kiosks are offline?** The backend returns 503 to
   the dashboard with a "no proxy available" message. We could add a
   small cache (e.g. last device-profile result, served stale-but-marked
   when no proxy is available). Probably not worth it for v0.3.
3. **Multiple kiosks pinging each other's data:** when the backend asks
   kiosk A for device-info on kiosk B, kiosk A makes the request on B's
   behalf. This is normal and Weimi doesn't care — the App ID is the same.

---

*Changes to this document must be agreed in both chats. Once approved,
this addendum's content will be merged into the main contract as v0.3.*
