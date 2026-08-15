package expo.modules.copypartysha512

import android.Manifest
import android.annotation.SuppressLint
import android.content.ContentResolver
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import android.provider.DocumentsContract
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.util.Base64
import android.util.Log
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.InputStream
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** SHA-512 truncated to its first 33 bytes — matches copyparty's wire format
 *  (`up2k.js:2218` `subarray(0, 33)`, `up2k.py:5716` `digest()[:33]`). 33 is
 *  divisible by 3 so base64url has no padding and is exactly 44 chars. */
private const val CHUNK_HASH_BYTES = 33

private const val READ_BUFFER_BYTES = 64 * 1024

private val B64_FLAGS = Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP

/** Query parameter `MediaStore.setRequireOriginal` appends; used to detect a
 *  URI we already decorated. Not exposed as public SDK API, so it's spelled
 *  out here rather than referenced off MediaStore. */
private const val PARAM_REQUIRE_ORIGINAL = "requireOriginal"

private const val TAG = "CopypartySha512"

/** Event carrying one batch of walked files to JS. See `src/sync/walker/saf.ts`. */
private const val EVENT_WALK_BATCH = "onWalkBatch"

/** `sizes()` sentinel for "no size available" — a real size is never negative.
 *  Reproduces the old behaviour where a throwing per-asset `size()` made
 *  `media.ts` skip that asset, except the skip is now decided JS-side for free. */
private const val SIZE_UNAVAILABLE = -1.0

/** `walkTree()` return value when JS cancelled the walk. */
private const val WALK_CANCELLED = -1

class CopypartySha512Module : Module() {
  /** In-flight walks by JS-supplied id. Concurrent because `cancelWalk` runs on
   *  the JS thread while the walk itself runs on `Dispatchers.IO`. */
  private val walks = ConcurrentHashMap<String, WalkToken>()

  override fun definition() = ModuleDefinition {
    Name("CopypartySha512")

    Events(EVENT_WALK_BATCH)

    AsyncFunction("hashFileChunks") { uri: String, chunksize: Int ->
      hashFileChunks(uri, chunksize)
    }

    AsyncFunction("readRange") { uri: String, car: Double, cdr: Double ->
      // JS numbers cross the bridge as Double; cast back to Long for byte offsets.
      readRange(uri, car.toLong(), cdr.toLong())
    }

    AsyncFunction("size") { uri: String ->
      // Returned as Double so JS sees a Number; safe up to 2^53 bytes.
      fileSize(parseUri(uri)).toDouble()
    }

    // Coroutine + Dispatchers.IO, NOT a plain AsyncFunction. `Queues.DEFAULT` is
    // a single HandlerThread shared by *every* Expo module in the app
    // (AppContext.modulesQueue), so a multi-second blocking walk parked there
    // also stalls expo-sqlite, expo-secure-store, expo-media-library and this
    // module's own hashFileChunks for its whole duration — which is a large part
    // of why "scanning" felt like a hang rather than a slow phase. Same
    // reasoning as copyparty-sync's canReadFolder.
    AsyncFunction("walkTree") Coroutine { treeUri: String, walkId: String ->
      withContext(Dispatchers.IO) { walkTree(treeUri, walkId) }
    }

    // Sync on purpose: sync functions run inline on the JS thread via JSI, so a
    // cancel lands immediately instead of queueing behind the walk it means to
    // cancel.
    Function("cancelWalk") { walkId: String ->
      walks[walkId]?.cancel()
    }

    AsyncFunction("sizes") Coroutine { uris: List<String> ->
      withContext(Dispatchers.IO) { sizes(uris) }
    }

    AsyncFunction("resolveReadUris") { uris: List<String> ->
      resolveReadUris(uris)
    }

    AsyncFunction("resolveReadUri") { uri: String ->
      effectiveUri(parseUri(uri), allowOriginal = canReadOriginals()).toString()
    }
  }

  private val context: Context
    get() = appContext.reactContext
      ?: throw HashException("react context unavailable")

  private val resolver: ContentResolver
    get() = context.contentResolver

  private fun parseUri(uri: String): Uri {
    val parsed = Uri.parse(uri)
    // A bare path like "/storage/emulated/0/foo.jpg" parses as a URI with no
    // scheme; ContentResolver.openInputStream needs a real scheme so we wrap
    // it as file://.
    return if (parsed.scheme == null) Uri.fromFile(File(uri)) else parsed
  }

  /**
   * The URI to open for byte-exact reads.
   *
   * On Android 10+ MediaProvider redacts the EXIF GPS block out of camera-roll
   * bytes unless the caller holds ACCESS_MEDIA_LOCATION *and* asks for the
   * original. Redaction zero-fills in place, so the length is unchanged but the
   * content is not what's on disk — which yields different SHA-512 chunk
   * hashes, a different copyparty wark, no dedup, and a backup that has
   * silently lost the user's location data.
   *
   * Only MediaStore media URIs are decorated. SAF tree URIs and file:// paths
   * pass through untouched.
   *
   * The permission is checked up front rather than by catching the failure per
   * call, because `hashFileChunks` and `readRange` MUST agree: if one fell back
   * to redacted bytes and the other didn't, we would POST chunk bodies that
   * don't match the hashes already sent in the handshake.
   */
  private fun effectiveUri(uri: Uri, allowOriginal: Boolean): Uri {
    if (!allowOriginal) return uri
    if (!isMediaStoreUri(uri)) return uri
    // Already decorated (the walker resolves once per asset) — don't re-wrap.
    if (uri.getQueryParameter(PARAM_REQUIRE_ORIGINAL) != null) return uri
    return MediaStore.setRequireOriginal(uri)
  }

  /**
   * May we ask MediaStore for unredacted originals at all? Hoisted out of
   * [effectiveUri] so a batch pays for the SDK check and the permission-manager
   * round trip once per call rather than once per asset — it cannot vary across
   * a page, and it was the only per-asset work this path ever did.
   */
  private fun canReadOriginals(): Boolean =
    Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && hasMediaLocationPermission()

  private fun isMediaStoreUri(uri: Uri): Boolean {
    if (uri.scheme != ContentResolver.SCHEME_CONTENT) return false
    val authority = uri.authority ?: return false
    // Cross-user URIs are "<userId>@media".
    return authority == MediaStore.AUTHORITY || authority.endsWith("@${MediaStore.AUTHORITY}")
  }

  @SuppressLint("InlinedApi") // ACCESS_MEDIA_LOCATION is a compile-time String constant
  private fun hasMediaLocationPermission(): Boolean =
    context.checkSelfPermission(Manifest.permission.ACCESS_MEDIA_LOCATION) ==
      PackageManager.PERMISSION_GRANTED

  private fun openStream(uri: Uri): InputStream =
    try {
      resolver.openInputStream(uri)
        ?: throw HashException("could not open input stream for $uri")
    } catch (e: UnsupportedOperationException) {
      // requireOriginal is only ever set after the permission check said yes,
      // so reaching here is anomalous. Failing this one file is correct —
      // silently re-reading the redacted stream would desync the hashes we
      // handshaked from the chunk bodies we upload.
      throw HashException("original media bytes unavailable for $uri: ${e.message}")
    } catch (e: SecurityException) {
      throw HashException("not permitted to read $uri: ${e.message}")
    }

  /** Deliberately queries the *undecorated* URI: EXIF redaction zero-fills in
   *  place and preserves length, so SIZE is the same either way, and passing an
   *  unexpected query parameter to the provider's matcher buys nothing. */
  private fun fileSize(uri: Uri): Long {
    if (uri.scheme == "file") {
      val path = uri.path ?: throw HashException("file uri has no path: $uri")
      return File(path).length()
    }
    resolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)?.use { c ->
      val idx = c.getColumnIndex(OpenableColumns.SIZE)
      if (idx >= 0 && c.moveToFirst() && !c.isNull(idx)) return c.getLong(idx)
    }
    throw HashException("could not determine size for $uri")
  }

  private fun hashFileChunks(uri: String, chunksize: Int): List<String> {
    if (chunksize <= 0) throw HashException("chunksize must be positive, got $chunksize")
    val parsed = effectiveUri(parseUri(uri), allowOriginal = canReadOriginals())
    return openStream(parsed).use { input ->
      val out = ArrayList<String>()
      val buf = ByteArray(READ_BUFFER_BYTES)
      var md = MessageDigest.getInstance("SHA-512")
      var inThisChunk = 0L
      val chunkLong = chunksize.toLong()

      while (true) {
        val n = input.read(buf, 0, buf.size)
        if (n < 0) break
        var off = 0
        while (off < n) {
          // Don't let one read straddle two chunks: split at the boundary.
          val take = minOf((chunkLong - inThisChunk), (n - off).toLong()).toInt()
          md.update(buf, off, take)
          inThisChunk += take
          off += take
          if (inThisChunk == chunkLong) {
            out.add(encodeTruncated(md))
            md = MessageDigest.getInstance("SHA-512")
            inThisChunk = 0
          }
        }
      }
      // Trailing partial chunk (the file's final segment).
      if (inThisChunk > 0) out.add(encodeTruncated(md))
      out
    }
  }

  private fun readRange(uri: String, car: Long, cdr: Long): ByteArray {
    if (car < 0 || cdr < car) throw HashException("invalid range: car=$car cdr=$cdr")
    val len = (cdr - car).toInt()
    val parsed = effectiveUri(parseUri(uri), allowOriginal = canReadOriginals())
    return openStream(parsed).use { input ->
      // InputStream.skip is allowed to short-skip; loop with a read fallback.
      var skipped = 0L
      while (skipped < car) {
        val s = input.skip(car - skipped)
        if (s > 0) {
          skipped += s
          continue
        }
        // Skip refused to advance; consume bytes manually.
        val tmpLen = minOf(8192L, car - skipped).toInt()
        val tmp = ByteArray(tmpLen)
        val n = input.read(tmp, 0, tmpLen)
        if (n < 0) throw HashException("eof while seeking to car=$car (got $skipped)")
        skipped += n
      }
      val out = ByteArray(len)
      var off = 0
      while (off < len) {
        val n = input.read(out, off, len - off)
        if (n < 0) throw HashException("eof while reading range [$car,$cdr) at offset $off")
        off += n
      }
      out
    }
  }

  /**
   * Walk a SAF tree URI, streaming one [EVENT_WALK_BATCH] event per batch of
   * FILES found (directories are recursed into, not emitted).
   *
   * Entries leave via events rather than the return value so the engine's scan
   * counters advance live and its cancel check lands mid-walk instead of after
   * it — on a 10,000-file folder the old single-promise shape meant a minutes-
   * long stretch where the UI showed "Scanning…" and Cancel did nothing. See
   * [SafTreeWalker] for why the traversal itself got ~1000x cheaper.
   *
   * @return the number of files emitted, or [WALK_CANCELLED] if JS cancelled.
   */
  private fun walkTree(treeUriString: String, walkId: String): Int {
    val treeUri = Uri.parse(treeUriString)
    val token = WalkToken()
    walks[walkId] = token
    val startedAt = SystemClock.elapsedRealtime()
    return try {
      SafTreeWalker(context, treeUri, token) { batch ->
        sendEvent(EVENT_WALK_BATCH, mapOf("walkId" to walkId, "entries" to batch))
      }.walk(rootDocumentId(treeUri)).also { n ->
        // Enumeration cost is the single easiest thing to regress here and the
        // hardest to notice — it is invisible from JS and shows up only as a
        // long "Scanning…". One line per run makes it greppable from logcat.
        Log.i(TAG, "walkTree: $n files in ${SystemClock.elapsedRealtime() - startedAt}ms")
      }
    } catch (e: WalkCancelledException) {
      // Resolve, don't reject: engine.ts treats anything the scan throws as a
      // run-level failure, but a user-requested cancel has to finalize the run
      // as 'cancelled'. The JS generator has already stopped by this point.
      WALK_CANCELLED
    } finally {
      walks.remove(walkId)
    }
  }

  private fun rootDocumentId(treeUri: Uri): String = try {
    // Mirrors androidx DocumentFile.fromTreeUri: normally the tree's own
    // document id, but a picker that hands back a document-uri-within-a-tree
    // gets that document's id instead. The buildChild/buildDocument helpers
    // only read the authority + tree segment off whichever URI they're given,
    // so every child URI built from `treeUri` below is string-identical to the
    // one DocumentFile produced — which file_state depends on, since
    // relativePath is the key but `uri` is what gets opened.
    if (DocumentsContract.isDocumentUri(context, treeUri)) {
      DocumentsContract.getDocumentId(treeUri)
    } else {
      DocumentsContract.getTreeDocumentId(treeUri)
    }
  } catch (e: IllegalArgumentException) {
    throw HashException("not a SAF tree uri: $treeUri")
  }

  /**
   * Sizes for a whole page of URIs in one round trip, and — for plain MediaStore
   * item URIs — one MediaStore query per collection instead of one per asset.
   * The camera-roll walker used to await [fileSize] once per asset, so a 10k
   * library cost 10k bridge hops and 10k ContentResolver queries before the
   * first byte uploaded.
   *
   * `OpenableColumns.SIZE` and `MediaStore.MediaColumns.SIZE` are both `_size`,
   * and a collection query is subject to the same scoped-storage visibility
   * filter as the per-item query, so the value is identical to what the old
   * per-URI `size()` returned. That matters: `file_state` short-circuits on it.
   *
   * @return one entry per input URI, in order; [SIZE_UNAVAILABLE] where the
   *   asset vanished or the provider had no size.
   */
  private fun sizes(uris: List<String>): List<Double> {
    val out = DoubleArray(uris.size) { SIZE_UNAVAILABLE }
    val byCollection = HashMap<Uri, HashMap<Long, MutableList<Int>>>()

    uris.forEachIndexed { i, raw ->
      val parsed = parseUri(raw)
      val collection = mediaCollectionFor(parsed)
      val id = parsed.lastPathSegment?.toLongOrNull()
      if (collection == null || id == null) {
        // file://, SAF, decorated or cross-user URI — take the old single-URI
        // path so this stays correct for any input the caller passes.
        out[i] = runCatching { fileSize(parsed).toDouble() }.getOrDefault(SIZE_UNAVAILABLE)
      } else {
        byCollection.getOrPut(collection) { HashMap() }.getOrPut(id) { ArrayList() }.add(i)
      }
    }

    for ((collection, idToIndexes) in byCollection) {
      // The ids came from Uri.lastPathSegment parsed as Long, so they are pure
      // digits; inlining them keeps a 200-asset page clear of SQLite's bind-
      // argument cap without opening any injection surface.
      val selection =
        "${MediaStore.MediaColumns._ID} IN (${idToIndexes.keys.joinToString(",")})"
      try {
        resolver.query(
          collection,
          arrayOf(MediaStore.MediaColumns._ID, MediaStore.MediaColumns.SIZE),
          selection,
          null,
          null,
        )?.use { c ->
          val iId = c.getColumnIndex(MediaStore.MediaColumns._ID)
          val iSize = c.getColumnIndex(MediaStore.MediaColumns.SIZE)
          if (iId < 0 || iSize < 0) return@use
          while (c.moveToNext()) {
            if (c.isNull(iSize)) continue
            val size = c.getLong(iSize).toDouble()
            idToIndexes[c.getLong(iId)]?.forEach { out[it] = size }
          }
        }
      } catch (t: Throwable) {
        // Sentinels stand, so JS drops exactly those assets — the same outcome
        // as when the old per-asset size() threw.
        Log.w(TAG, "batch size query failed for $collection", t)
      }
    }
    return out.toList()
  }

  /** The MediaStore collection a plain `content://media/external/<kind>/media/<id>`
   *  URI belongs to, or null for anything else (file://, SAF, already decorated,
   *  or a cross-user `<id>@media` authority we shouldn't guess at). */
  private fun mediaCollectionFor(uri: Uri): Uri? {
    if (uri.scheme != ContentResolver.SCHEME_CONTENT) return null
    if (uri.authority != MediaStore.AUTHORITY) return null
    if (uri.query != null) return null
    val seg = uri.pathSegments // [external, images, media, <id>]
    if (seg.size != 4 || seg[2] != "media") return null
    return when (seg[1]) {
      "images" -> MediaStore.Images.Media.getContentUri(seg[0])
      "video" -> MediaStore.Video.Media.getContentUri(seg[0])
      else -> null
    }
  }

  /**
   * [effectiveUri] for a whole page in one round trip. There is no
   * ContentResolver query on this path at all — the per-asset cost was purely
   * the bridge hop plus a permission-manager check whose answer cannot vary
   * across a page, so [canReadOriginals] is hoisted out of the loop.
   */
  private fun resolveReadUris(uris: List<String>): List<String> {
    val allowOriginal = canReadOriginals()
    return uris.map { effectiveUri(parseUri(it), allowOriginal).toString() }
  }

  private fun encodeTruncated(md: MessageDigest): String {
    val full = md.digest() // 64 bytes
    val sliced = full.copyOfRange(0, CHUNK_HASH_BYTES)
    return Base64.encodeToString(sliced, B64_FLAGS)
  }
}

/** Shared with SafTreeWalker, hence internal rather than file-private. */
internal class HashException(message: String) : CodedException(message)
