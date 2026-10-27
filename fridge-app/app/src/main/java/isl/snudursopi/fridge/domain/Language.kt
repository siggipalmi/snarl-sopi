package isl.snudursopi.fridge.domain

import kotlinx.serialization.Serializable

@Serializable
enum class Language(val code: String, val displayName: String) {
    Icelandic("is", "íslenska"),
    English("en", "english"),
    Polish("pl", "polski"),
}

object LanguageCycle {
    fun next(current: Language, available: List<Language>): Language {
        if (available.isEmpty()) return current
        val idx = available.indexOf(current)
        if (idx < 0) return available.first()
        return available[(idx + 1) % available.size]
    }

    fun isToggleEnabled(available: List<Language>): Boolean = available.size >= 2
}
