package isl.snudursopi.vending.data.ads

import android.content.Context
import android.net.Uri
import android.util.Log
import isl.snudursopi.vending.data.backend.RemoteAd
import isl.snudursopi.vending.domain.AdOverlay
import isl.snudursopi.vending.domain.AdSlot
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * Local copies of the machine's ads, so the ad region never streams.
 *
 * Until 0.80.2 the region played a hard-coded playlist whose video was fetched from
 * Google's servers on every rotation — a download every few minutes, around the clock,
 * on machines that sit on a SIM router. The backend has carried a per-machine ad list
 * the whole time; the app just never read it.
 *
 * The rule here is simple: an ad is playable only once its file is on disk. [playable]
 * returns slots for the files that exist, pointing at the files, never at the URLs.
 * [sync] downloads what is missing and deletes what is no longer listed. A new poster
 * costs one download; after that, nothing.
 */
class AdCache(context: Context) {
    private val dir = File(context.filesDir, "ads").apply { mkdirs() }

    /** The ads whose file is on disk, in list order, each pointing at its local copy. */
    fun playable(ads: List<RemoteAd>): List<AdSlot> = ads.mapNotNull { ad ->
        val f = fileFor(ad)
        if (!f.isFile || f.length() == 0L) return@mapNotNull null
        val local = Uri.fromFile(f).toString()
        val id = f.nameWithoutExtension
        when (ad.type) {
            "video" -> AdSlot.Video(id = id, videoUrl = local, maxDurationSeconds = ad.durationSec)
            else -> AdSlot.Image(
                id = id,
                imageUrl = local,
                overlay = ad.overlayText?.let { AdOverlay(eyebrow = "", titleLines = listOf(it)) },
                durationSeconds = ad.durationSec,
            )
        }
    }

    /**
     * Download the ads not yet on disk and remove files for ads no longer listed.
     * Returns how many were downloaded. One failure doesn't stop the others.
     */
    suspend fun sync(ads: List<RemoteAd>): Int = withContext(Dispatchers.IO) {
        val wanted = ads.associateBy { fileFor(it).name }
        // Prune first, so a long-gone 80 MB clip doesn't sit beside its replacement.
        dir.listFiles()?.forEach { f ->
            if (f.name !in wanted && !f.name.endsWith(PART)) {
                if (f.delete()) Log.i(TAG, "removed ${f.name} (no longer listed)")
            }
        }
        var fetched = 0
        for (ad in ads) {
            val f = fileFor(ad)
            if (f.isFile && f.length() > 0L) continue
            try {
                download(ad.url, f)
                fetched++
                Log.i(TAG, "cached ${ad.type} ${f.name} (${f.length() / 1024} kB)")
            } catch (e: Exception) {
                Log.w(TAG, "could not cache ${ad.url}: ${e.message}")
            }
        }
        fetched
    }

    private fun download(url: String, dest: File) {
        val part = File(dest.path + PART)
        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 20_000; readTimeout = 30_000
            instanceFollowRedirects = true
        }
        try {
            if (conn.responseCode !in 200..299) throw IllegalStateException("HTTP ${conn.responseCode}")
            val declared = conn.contentLengthLong
            if (declared > MAX_BYTES) throw IllegalStateException("$declared bytes exceeds the ${MAX_BYTES / 1_048_576} MB cap")
            var total = 0L
            conn.inputStream.use { input ->
                part.outputStream().use { out ->
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        val n = input.read(buf); if (n < 0) break
                        total += n
                        if (total > MAX_BYTES) throw IllegalStateException("exceeds the ${MAX_BYTES / 1_048_576} MB cap")
                        out.write(buf, 0, n)
                    }
                }
            }
            if (total == 0L) throw IllegalStateException("empty body")
            if (!part.renameTo(dest)) throw IllegalStateException("rename failed")
        } finally {
            conn.disconnect()
            if (part.exists()) part.delete()
        }
    }

    /** Stable name per URL, so an unchanged ad is never fetched twice. */
    private fun fileFor(ad: RemoteAd): File {
        val digest = MessageDigest.getInstance("SHA-256").digest(ad.url.toByteArray())
        val key = digest.joinToString("") { "%02x".format(it) }.take(32)
        val fromUrl = ad.url.substringBefore('?').substringAfterLast('.', "").lowercase()
        val ext = fromUrl.takeIf { it.length in 2..4 && it.all(Char::isLetterOrDigit) }
            ?: if (ad.type == "video") "mp4" else "jpg"
        return File(dir, "$key.$ext")
    }

    private companion object {
        const val TAG = "AdCache"
        const val PART = ".part"
        /** A 16:9 poster is well under 1 MB; a short clip a few tens. Anything bigger is a mistake. */
        const val MAX_BYTES = 80L * 1024 * 1024
    }
}
