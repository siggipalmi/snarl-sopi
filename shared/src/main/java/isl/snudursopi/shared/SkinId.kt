package isl.snudursopi.shared

/**
 * Which look a kiosk draws. Chosen in the dashboard (AG only) per operator, with a per-machine
 * override for canaries, and carried in the config as `skin`. Both apps parse it here so the wire
 * names stay one list; the tokens themselves live in each app's theme.
 *
 * Unknown or missing → [Classic], so a machine never blanks on a value it does not know.
 */
enum class SkinId(val wire: String) {
    Classic("classic"),
    Franklin("franklin");

    companion object {
        fun parse(s: String?): SkinId = entries.firstOrNull { it.wire.equals(s?.trim(), ignoreCase = true) } ?: Classic
    }
}
