package isl.snudursopi.vending.domain

import kotlinx.serialization.Serializable

@Serializable
data class MachineSettings(
    val machineName: String = "",
    val operatorName: String = "",
    val showAdRegion: Boolean = false,
    val showLeftHero: Boolean = true,
    val showRightHero: Boolean = true,
    /**
     * Manually-curated featured products shown in the hero zone above the grid.
     * Each entry pairs a Weimi goodsId with an editorial tag ("vinsælt",
     * "nýtt", "tilboð"). Today these are set in code via the ViewModel default.
     * TODO: populate from admin backend per-machine when that ships.
     */
    val featured: List<FeaturedProduct> = emptyList(),
    /**
     * Rotating ad slots shown above the greeting. Empty disables the
     * ad zone entirely. Populated from admin backend in production.
     */
    val ads: List<AdSlot> = emptyList(),
    val adRotation: AdRotationConfig = AdRotationConfig(),
    val showIdleScreen: Boolean = false,
    val idleTimeoutSeconds: Int = 60,
    val defaultLanguage: Language = Language.Icelandic,
    val availableLanguages: List<Language> = listOf(Language.Icelandic, Language.English),
    val supportEmail: String = "hallo@snarlogsopi.is",
    val supportCustomMessage: String = "",
    val hasHeatedGlass: Boolean = true,
    val heatedGlassDefaultOn: Boolean = true,
    val hasLedStrips: Boolean = true,
    val ledBrightness: Int = 8,
    val motorSerialPort: String = "/dev/ttyS3",
    val controlBoardAddress: Int = 0,
)

/**
 * A product the operator has marked as featured, with its editorial tag.
 */
@Serializable
data class FeaturedProduct(
    /** Weimi goodsId — matches Product.id after consolidation. */
    val goodsId: String,
    /** Italic Cormorant tag shown above the product name in the hero tile. */
    val tag: String,
    /** Sort order for the hero zone, ascending. From backend config. */
    val order: Int = 0,
)
