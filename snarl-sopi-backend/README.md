# Snúður & Sopi — Operator Backend API

Node.js HTTP server (zero external dependencies). Provides:
1. **Kiosk-facing config endpoints** — replaces all hardcoded `TODO: admin backend` stubs in `VendingViewModel`
2. **Operator web frontend API** — powers the operator dashboard HTML file

---

## Quick start

```bash
node src/server.js
# → http://localhost:3000
```

Environment variables (all optional):
```
PORT=3000
JWT_SECRET=change-me-in-production
KIOSK_SECRET=change-me-in-production
```

---

## Authentication

### Operator frontend
All `/api/v1/*` endpoints (except `/health` and `/api/v1/auth/login`) require:
```
Authorization: Bearer <token>
```
Get a token via `POST /api/v1/auth/login`.

**Demo credentials** (prototype only — replace with real password hashing in production):
| Email | Password | Role |
|---|---|---|
| sky@example.com | demo | super_admin |
| jane@example.com | demo | operator |
| mike@example.com | demo | technician |

### Kiosk app
All `/api/v1/kiosk/*` endpoints require:
```
X-Kiosk-Secret: <shared-secret>
```
Default dev secret: `kiosk-dev-secret`

---

## Endpoints

### Health
```
GET /health
→ { ok: true, version, uptime }
```

### Auth
```
POST /api/v1/auth/login
Body: { email, password }
→ { token, user }
```

---

### Kiosk-facing (called by VendingViewModel)

#### GET /api/v1/kiosk/:deviceCode/config
**The main kiosk endpoint.** Returns everything `loadCatalog()` needs
from the backend — replaces all three `TODO: admin backend` comments.

Response:
```json
{
  "deviceCode": "62160487",
  "settings": {
    "machineName": "Gamli Gerpla",
    "operatorName": "AG Vending",
    "showAdRegion": true,
    "showLeftHero": true,
    "showRightHero": true,
    "showIdleScreen": false,
    "idleTimeoutSeconds": 60,
    "defaultLanguage": "Icelandic",
    "availableLanguages": ["Icelandic", "English"],
    "supportEmail": "hallo@snarlogsopi.is",
    "supportCustomMessage": "",
    "hasHeatedGlass": true,
    "heatedGlassDefaultOn": true,
    "hasLedStrips": true,
    "ledBrightness": 8,
    "motorSerialPort": "/dev/ttyS3",
    "controlBoardAddress": 0
  },
  "featured": [
    { "goodsId": "884ab184f243b26cac38bc355e867bd7", "tag": "vinsælt" },
    { "goodsId": "0efe2a87038db4e9c7e063f2a5769fbc", "tag": "nýtt" }
  ],
  "productOverrides": {
    "884ab184f243b26cac38bc355e867bd7": { "featured": true, "hidden": false, "hideWhenEmpty": true, "displayOrder": 60 }
  },
  "adContent": { "type": "static", "label": "fylkir · íþróttadrykkur", "assetUrl": null },
  "unsupported": false,
  "servedAt": "2026-05-19T..."
}
```

#### GET /api/v1/kiosk/:deviceCode/operator
Lightweight endpoint returning just the sub-operator name.
Useful if the kiosk wants to refresh the brand line without fetching the full config.

```json
{ "deviceCode": "62160487", "operatorName": "AG Vending", "subOperator": "AG Vending" }
```

---

### Machines

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/machines` | List all machines (summary) |
| GET | `/api/v1/machines/:deviceCode` | Full machine detail incl. settings |
| PUT | `/api/v1/machines/:deviceCode/settings` | Update MachineSettings fields |
| GET | `/api/v1/machines/:deviceCode/featured` | Get featured products list |
| PUT | `/api/v1/machines/:deviceCode/featured` | Replace featured products list |
| PUT | `/api/v1/machines/:deviceCode/products/:productId` | Update product flag overrides |

**PUT /settings body** (all fields optional — only provided fields are updated):
```json
{
  "operatorName": "Fylkir Sport",
  "showAdRegion": true,
  "showLeftHero": true,
  "showRightHero": false,
  "showIdleScreen": true,
  "idleTimeoutSeconds": 45,
  "defaultLanguage": "English",
  "availableLanguages": ["Icelandic", "English"],
  "supportEmail": "hallo@snarlogsopi.is",
  "ledBrightness": 8
}
```

**PUT /featured body** (replaces the entire list, max 4):
```json
[
  { "goodsId": "884ab184f243b26cac38bc355e867bd7", "tag": "vinsælt" },
  { "goodsId": "0efe2a87038db4e9c7e063f2a5769fbc", "tag": "nýtt" }
]
```

**PUT /products/:productId body**:
```json
{
  "hidden": false,
  "hideWhenEmpty": true,
  "featured": true,
  "displayOrder": 60
}
```

---

### Alerts

```
GET  /api/v1/alerts?type=&deviceCode=&resolved=
POST /api/v1/alerts/:id/resolve
```

Alert types: `offline`, `stock`, `payment`, `kiosk`, `config`

---

### Orders

```
GET /api/v1/orders?deviceCode=&page=1&size=50
```

Status codes (matching Weimi): `1`=success, `2`=failed, `3`=refunded

---

### Reports

```
GET /api/v1/reports/summary
```

---

### Users

```
GET  /api/v1/users         (super_admin only)
POST /api/v1/users         (super_admin only)
Body: { name, email, role }
Roles: super_admin | operator | technician
```

---

## Kiosk app integration

These are the exact changes needed in the kiosk app (`VendingViewModel.kt`)
to wire up the backend instead of the hardcoded stubs.

### 1. Add BackendApiClient

Create `app/src/main/java/isl/snudursopi/vending/api/BackendApiClient.kt`:

```kotlin
package isl.snudursopi.vending.api

import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import okhttp3.OkHttpClient
import okhttp3.Request

class BackendApiClient(
    private val baseUrl: String = BACKEND_URL,
    private val kioskSecret: String = KIOSK_SECRET,
) {
    private val mapper = jacksonObjectMapper()
    private val client = OkHttpClient()

    /** Fetch MachineSettings, featured products, and product overrides. */
    suspend fun fetchConfig(deviceCode: String): BackendConfig? {
        return try {
            val req = Request.Builder()
                .url("$baseUrl/api/v1/kiosk/$deviceCode/config")
                .header("X-Kiosk-Secret", kioskSecret)
                .get().build()
            val body = client.newCall(req).execute().body?.string() ?: return null
            val root = mapper.readTree(body)
            if (root.get("ok")?.asBoolean() != true) return null
            mapper.treeToValue(root.get("data"), BackendConfig::class.java)
        } catch (e: Exception) {
            android.util.Log.w("BackendApi", "fetchConfig failed: ${e.message}")
            null
        }
    }

    companion object {
        const val BACKEND_URL = "http://10.0.2.2:3000"   // localhost from Android emulator
        const val KIOSK_SECRET = "kiosk-dev-secret"
    }
}

data class BackendConfig(
    val deviceCode: String,
    val settings: Map<String, Any>,
    val featured: List<Map<String, String>>,
    val productOverrides: Map<String, Map<String, Any>>,
    val unsupported: Boolean = false,
    val unsupportedReason: String? = null,
)
```

### 2. Patch VendingViewModel.loadCatalog()

Replace the three hardcoded stubs with backend calls:

```kotlin
// BEFORE (three separate TODOs in loadCatalog):
val operatorName = "AG Vending"                          // TODO: admin backend
val featured = defaultFeatured()                          // TODO: admin backend
// (no product override support at all)

// AFTER:
val backendConfig = BackendApiClient().fetchConfig(deviceCode)

val operatorName = backendConfig?.settings?.get("operatorName") as? String
    ?: profile?.deviceName
    ?: "snúður & sopi"

val featuredFromBackend = backendConfig?.featured
    ?.map { FeaturedProduct(goodsId = it["goodsId"]!!, tag = it["tag"]!!) }
    ?: defaultFeatured()

// Apply product overrides from backend to the catalog
val catalogWithOverrides = if (backendConfig?.productOverrides != null) {
    products.map { product ->
        val overrides = backendConfig.productOverrides[product.id]
        if (overrides != null) product.copy(
            hidden = overrides["hidden"] as? Boolean ?: product.hidden,
            hideWhenEmpty = overrides["hideWhenEmpty"] as? Boolean ?: product.hideWhenEmpty,
            featured = overrides["featured"] as? Boolean ?: product.featured,
            displayOrder = (overrides["displayOrder"] as? Number)?.toInt() ?: product.displayOrder,
        ) else product
    }
} else products
```

### 3. Handle unsupported devices from backend

The backend also exposes `unsupported`/`unsupportedReason` per device.
You can move the `UNSUPPORTED_DEVICES` hardcoded set out of the ViewModel
and into the backend:

```kotlin
// In loadCatalog(), after fetchConfig:
if (backendConfig?.unsupported == true) {
    val error = IllegalStateException(
        backendConfig.unsupportedReason ?: "Device $deviceCode is not supported."
    )
    _state.update { it.copy(phase = Phase.Error, fatalError = error) }
    return
}
```

---

## Production checklist

- [ ] Replace in-memory `db.js` with a real database (SQLite or Postgres)
- [ ] Add proper password hashing (bcrypt) to auth
- [ ] Rotate `KIOSK_SECRET` and `JWT_SECRET` via environment variables
- [ ] Move `WeimiCredentials` out of source and serve from backend config
- [ ] Add HTTPS (TLS termination at nginx/caddy in front of this server)
- [ ] Implement Weimi API proxy endpoints (forward `/ext/device-info` calls through backend so Weimi credentials never live on the tablet)
- [ ] Add persistence for alerts (currently in-memory, lost on restart)
- [ ] Implement alert webhooks / push notifications to operator mobile
- [ ] Rate-limit kiosk endpoints to prevent abuse
