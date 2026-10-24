package isl.snudursopi.vending.data.backend

import com.fasterxml.jackson.databind.JsonNode
import isl.snudursopi.vending.domain.FeaturedProduct
import isl.snudursopi.vending.domain.IdleCard
import isl.snudursopi.vending.domain.IdleCardType
import isl.snudursopi.vending.domain.IdleConfig
import isl.snudursopi.vending.domain.IdleDiscount
import isl.snudursopi.vending.domain.IdleItem
import isl.snudursopi.vending.domain.ComboGroup
import isl.snudursopi.vending.domain.ComboItem
import isl.snudursopi.vending.domain.Offer
import isl.snudursopi.vending.domain.OfferKind
import isl.snudursopi.vending.domain.toOfferKind

/**
 * Fetches the per-machine config from the admin backend and parses the
 * `featured` / `profile` blocks the kiosk cares about.
 *
 * Endpoint: `GET /api/v1/machines/{deviceCode}/config`
 *   - Auth: `X-Machine-Key` (handled by [AdminBackendHttp])
 *   - `If-None-Match: <configVersion>` → 304 when unchanged
 *
 * Envelope:
 * ```
 * { "ok": true, "data": {
 *     "profile": { "operatorName", "machineLabel", "supportEmail", "supportPhone" },
 *     "featured": [ { "goodsId", "tag", "order" }, ... ],
 *     "ads": [...],
 *     "configVersion": "<etag>"
 * } }
 * ```
 *
 * This client does NOT resolve featured goodsIds against the catalog —
 * that's the ViewModel's job (it has the live product list). This just
 * turns JSON into typed config.
 */
class ConfigClient(
    private val http: AdminBackendHttp,
) {
    /**
     * Fetch config for [deviceCode], sending [etag] as If-None-Match.
     *
     * Returns:
     *  - [Result.Unchanged] on 304 — keep the cached config (still a heartbeat).
     *  - [Result.Loaded] on 200 — parsed config + new configVersion.
     *
     * Throws [BackendException] on real failures (the caller decides
     * retry vs terminal, per Kind).
     */
    suspend fun fetch(deviceCode: String, etag: String?): Result {
        val path = "/api/v1/machines/$deviceCode/config"
        return when (val fetch = http.getJsonWithEtag(path, etag)) {
            is ConfigFetch.NotModified -> Result.Unchanged
            is ConfigFetch.Modified -> parse(fetch.body)
        }
    }

    private fun parse(root: JsonNode): Result.Loaded {
        // Tolerate both enveloped ({ok,data:{...}}) and bare ({...}) shapes.
        val data = root.get("data")?.takeIf { it.isObject } ?: root

        val featured = data.get("featured")?.takeIf { it.isArray }
            ?.mapNotNull { node ->
                val goodsId = node.get("goodsId")?.asText()?.takeIf { it.isNotBlank() }
                    ?: return@mapNotNull null
                val tag = node.get("tag")?.asText().orEmpty()
                val order = node.get("order")?.asInt() ?: 0
                FeaturedProduct(goodsId = goodsId, tag = tag, order = order)
            }
            ?.sortedBy { it.order }
            ?: emptyList()

        val profileNode = data.get("profile")?.takeIf { it.isObject }
        val profile = profileNode?.let {
            ConfigProfile(
                operatorName = it.get("operatorName")?.asText().orEmpty(),
                machineLabel = it.get("machineLabel")?.asText().orEmpty(),
                supportEmail = it.get("supportEmail")?.asText()?.takeIf { e -> e.isNotBlank() },
                supportPhone = it.get("supportPhone")?.asText()?.takeIf { p -> p.isNotBlank() },
            )
        }

        val configVersion = data.get("configVersion")?.asText()?.takeIf { it.isNotBlank() }

        // gridOrder: operator-defined on-screen order, a list of goodsIds.
        // Absent/empty → empty list → kiosk keeps default slot order.
        val gridOrder = data.get("gridOrder")?.takeIf { it.isArray }
            ?.mapNotNull { it.asText()?.takeIf { id -> id.isNotBlank() } }
            ?: emptyList()

        // hardware.dropSensor: "on" | "off" (absent → null → treat as "off").
        val dropSensor = data.get("hardware")?.get("dropSensor")
            ?.asText()?.takeIf { it.isNotBlank() }

        // disabledAisles: aisle codes the operator has closed (broken motor, etc.).
        // Kiosk hides + refuses these. Tolerant of BOTH placements (hardware.* or
        // top-level) and BOTH code formats (Weimi "0-A03" or friendly "A3") — the
        // backend seeds this and we don't want a nesting/format mismatch to silently
        // break the loop. Everything is normalized to friendly ("A3").
        val disabledAislesNode = data.get("hardware")?.get("disabledAisles")?.takeIf { it.isArray }
            ?: data.get("disabledAisles")?.takeIf { it.isArray }
        val rawDisabled = disabledAislesNode?.mapNotNull { it.asText() } ?: emptyList()
        val disabledAisles = rawDisabled
            .mapNotNull { isl.snudursopi.vending.api.SlotCodeTranslator.normalize(it) }
        // A code we cannot decode is NOT harmless: it drops out here and the lane
        // the operator believes is closed goes back on sale, silently. Shout about
        // it — a noisy log is the cheapest possible warning that a bay we think is
        // shut is actually taking money.
        val undecodableAisles = rawDisabled.filter {
            isl.snudursopi.vending.api.SlotCodeTranslator.normalize(it) == null
        }
        if (undecodableAisles.isNotEmpty()) {
            val undecodable = undecodableAisles
            android.util.Log.w(
                "ConfigClient",
                "disabledAisles: could NOT decode $undecodable — those lanes are NOT closed " +
                    "and will remain on sale. Decoded ${disabledAisles.size}/${rawDisabled.size}.",
            )
        }

        // idle: ready-to-render attract-screen deal cards (already filtered to
        // this machine and in display order by the backend). Absent → EMPTY.
        val idle = parseIdle(data.get("idle"))

        val offers = data.get("offers")?.takeIf { it.isArray }
            ?.mapNotNull { node ->
                val goodsId = node.get("goodsId")?.asText()?.takeIf { it.isNotBlank() }
                    ?: return@mapNotNull null
                val kind = node.get("kind")?.asText().toOfferKind()
                if (kind == OfferKind.Unknown) return@mapNotNull null
                val groups = node.get("groups")?.takeIf { it.isArray }
                    ?.map { g ->
                        ComboGroup(
                            label = g.get("label")?.asText()?.takeIf { it.isNotBlank() },
                            items = g.get("items")?.takeIf { it.isArray }
                                ?.mapNotNull { itm ->
                                    val gid = itm.get("goodsId")?.asText()?.takeIf { it.isNotBlank() }
                                        ?: return@mapNotNull null
                                    ComboItem(goodsId = gid, name = itm.get("name")?.asText().orEmpty())
                                }
                                ?: emptyList(),
                        )
                    }
                    ?: emptyList()
                Offer(
                    goodsId = goodsId,
                    kind = kind,
                    value = node.get("value")?.takeIf { !it.isNull }?.asInt(),
                    daysLeft = node.get("daysLeft")?.takeIf { !it.isNull }?.asInt(),
                    discountedPriceIsk = node.get("discountedPriceIsk")?.takeIf { !it.isNull }?.asInt(),
                    qty = node.get("qty")?.takeIf { !it.isNull }?.asInt(),
                    totalKr = node.get("totalKr")?.takeIf { !it.isNull }?.asInt(),
                    comboId = node.get("comboId")?.asText()?.takeIf { it.isNotBlank() },
                    comboGroups = groups,
                )
            }
            ?: emptyList()

        // stockSource: "kiosk" | "weimi" (absent → "weimi").
        val stockSource = data.get("stockSource")?.asText()?.takeIf { it.isNotBlank() } ?: "weimi"

        // stock: per-goodsId current count (summed across bays, includes 0).
        val stock: Map<String, Int> = data.get("stock")?.takeIf { it.isObject }?.let { node ->
            buildMap {
                node.fields().forEach { (k, v) -> if (!v.isNull) put(k, v.asInt()) }
            }
        } ?: emptyMap()

        // images: per-goodsId backend-hosted (R2) normalized product image.
        // Only products the backend has migrated appear here; an absent goodsId
        // means "not migrated yet" → the kiosk keeps its local Weimi image.
        val images: Map<String, BackendImage> = data.get("images")?.takeIf { it.isObject }?.let { node ->
            buildMap {
                node.fields().forEach { (k, v) ->
                    val url = v?.get("url")?.asText()?.takeIf { it.isNotBlank() }
                    if (url != null) {
                        put(k, BackendImage(url, v.get("hasBackground")?.asBoolean() ?: false))
                    }
                }
            }
        } ?: emptyMap()

        // commands.restartApp / restartMachine: epoch-ms edge triggers (or null).
        // Big values (epoch ms) → asLong, never asInt.
        val commandsNode = data.get("commands")?.takeIf { it.isObject }
        val restartApp = commandsNode?.get("restartApp")?.takeIf { !it.isNull }?.asLong()
        val restartMachine = commandsNode?.get("restartMachine")?.takeIf { !it.isNull }?.asLong()

        return Result.Loaded(
            featured = featured,
            profile = profile,
            configVersion = configVersion,
            gridOrder = gridOrder,
            dropSensor = dropSensor,
            disabledAisles = disabledAisles,
            undecodableAisles = undecodableAisles,
            idle = idle,
            offers = offers,
            stockSource = stockSource,
            stock = stock,
            images = images,
            restartApp = restartApp,
            restartMachine = restartMachine,
        )
    }

    private fun parseIdle(node: JsonNode?): IdleConfig {
        if (node == null || !node.isObject) return IdleConfig.EMPTY
        val rotation = node.get("rotationSeconds")?.asInt()?.takeIf { it > 0 } ?: 6
        val attractTimeout = node.get("attractTimeoutSeconds")?.asInt()?.takeIf { it > 0 } ?: 30
        val cards = node.get("cards")?.takeIf { it.isArray }
            ?.mapNotNull { parseCard(it) }
            ?: emptyList()
        return IdleConfig(rotationSeconds = rotation, attractTimeoutSeconds = attractTimeout, cards = cards)
    }

    private fun parseCard(node: JsonNode): IdleCard? {
        val dealId = node.get("dealId")?.asText()?.takeIf { it.isNotBlank() } ?: return null
        val type = when (node.get("type")?.asText()?.lowercase()) {
            "markdown" -> IdleCardType.Markdown
            "expiry" -> IdleCardType.Expiry
            "multibuy" -> IdleCardType.Multibuy
            "combo" -> IdleCardType.Combo
            else -> IdleCardType.Unknown
        }
        if (type == IdleCardType.Unknown) return null  // skip shapes we can't render
        val items = node.get("items")?.takeIf { it.isArray }?.map { parseItem(it) } ?: emptyList()
        val groups = node.get("groups")?.takeIf { it.isArray }
            ?.map { g -> g.get("items")?.takeIf { it.isArray }?.map { parseItem(it) } ?: emptyList() }
            ?: emptyList()
        val d = node.get("discount")
        val discount = IdleDiscount(
            kind = d?.get("kind")?.asText().orEmpty(),
            value = d?.get("value")?.takeIf { !it.isNull }?.asInt(),
            maxPercent = d?.get("maxPercent")?.takeIf { !it.isNull }?.asInt(),
            qty = d?.get("qty")?.takeIf { !it.isNull }?.asInt(),
            totalKr = d?.get("totalKr")?.takeIf { !it.isNull }?.asInt(),
            mode = d?.get("mode")?.asText()?.takeIf { it.isNotBlank() },
        )
        return IdleCard(
            dealId = dealId,
            dealName = node.get("dealName")?.asText().orEmpty(),
            type = type,
            discount = discount,
            itemCount = node.get("itemCount")?.asInt() ?: items.size,
            items = items,
            groups = groups,
        )
    }

    private fun parseItem(node: JsonNode): IdleItem = IdleItem(
        goodsId = node.get("goodsId")?.asText()?.takeIf { it.isNotBlank() },
        name = node.get("name")?.asText().orEmpty(),
        imgUrl = node.get("imgUrl")?.asText()?.takeIf { it.isNotBlank() },
        priceIsk = node.get("priceIsk")?.takeIf { !it.isNull }?.asInt(),
        discountedPriceIsk = node.get("discountedPriceIsk")?.takeIf { !it.isNull }?.asInt(),
        percent = node.get("percent")?.takeIf { !it.isNull }?.asInt(),
        daysLeft = node.get("daysLeft")?.takeIf { !it.isNull }?.asInt(),
    )

    sealed class Result {
        /** 304 — config unchanged. */
        object Unchanged : Result()

        /** 200 — parsed config. [featured] already sorted by order ascending. */
        data class Loaded(
            val featured: List<FeaturedProduct>,
            val profile: ConfigProfile?,
            val configVersion: String?,
            /** Operator-defined grid order as goodsIds; empty = default slot order. */
            val gridOrder: List<String> = emptyList(),
            /** hardware.dropSensor: "on"|"off"|null (null → treat as off). */
            val dropSensor: String? = null,
            /** hardware.disabledAisles: friendly codes closed by the operator. */
            val disabledAisles: List<String> = emptyList(),
            /**
             * Entries of hardware.disabledAisles this build could NOT decode, kept
             * verbatim. Non-empty means the backend and the kiosk disagree about
             * slot numbering and those lanes are NOT closed here — they are still
             * on sale. Surfaced by the `config_health` command, because on a
             * sideloaded machine there is no adb and no log relay, so a WARN line
             * in logcat is written where nobody can read it.
             */
            val undecodableAisles: List<String> = emptyList(),
            /** Attract-screen deal cards, ready to render (or EMPTY). */
            val idle: IdleConfig = IdleConfig.EMPTY,
            /** Per-product offer flags for grid badging (or empty). */
            val offers: List<Offer> = emptyList(),
            /** Stock model: "kiosk" (backend-owned) | "weimi" (legacy sync). */
            val stockSource: String = "weimi",
            /** Per-goodsId current count from the config `stock` block. */
            val stock: Map<String, Int> = emptyMap(),
            /** Per-goodsId backend-hosted normalized image. Absent goodsId = not
             *  migrated → keep the local Weimi image for that product. */
            val images: Map<String, BackendImage> = emptyMap(),
            /** commands.restartApp epoch-ms (or null). Edge trigger: act when greater than last-acted. */
            val restartApp: Long? = null,
            /** commands.restartMachine epoch-ms (or null). Parsed; reboot path TBD. */
            val restartMachine: Long? = null,
        ) : Result()
    }
}

/**
 * A backend-hosted (Cloudflare R2), normalized product image from the config
 * `images` block. [url] is versioned — it changes when the image changes, so
 * caches bust on their own. [hasBackground] is auto-detected by the backend
 * (transparent-edged cut-out → false; baked-in/white-padded photo → true).
 */
data class BackendImage(
    val url: String,
    val hasBackground: Boolean,
)

/**
 * Operator/machine profile from config. Optional fields are null when the
 * backend omits them (e.g. no support phone).
 */
data class ConfigProfile(
    val operatorName: String,
    val machineLabel: String,
    val supportEmail: String?,
    val supportPhone: String?,
)
