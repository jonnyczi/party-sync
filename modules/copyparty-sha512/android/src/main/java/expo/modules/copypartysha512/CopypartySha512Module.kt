package expo.modules.copypartysha512

import android.Manifest
import android.annotation.SuppressLint
import android.content.ContentResolver
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.util.Base64
import androidx.documentfile.provider.DocumentFile
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.InputStream
import java.security.MessageDigest

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

class CopypartySha512Module : Module() {
  override fun definition() = ModuleDefinition {
    Name("CopypartySha512")

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

    AsyncFunction("walkTree") { treeUri: String ->
      walkTree(treeUri)
    }

    AsyncFunction("resolveReadUri") { uri: String ->
      effectiveUri(parseUri(uri)).toString()
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
  private fun effectiveUri(uri: Uri): Uri {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return uri
    if (!isMediaStoreUri(uri)) return uri
    // Already decorated (the walker resolves once per asset) — don't re-wrap.
    if (uri.getQueryParameter(PARAM_REQUIRE_ORIGINAL) != null) return uri
    if (!hasMediaLocationPermission()) return uri
    return MediaStore.setRequireOriginal(uri)
  }

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
    val parsed = effectiveUri(parseUri(uri))
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
    val parsed = effectiveUri(parseUri(uri))
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
   * Walk a SAF tree URI and return one entry per FILE under the tree (dirs
   * are recursed into, not emitted). `relativePath` is a forward-slash path
   * rooted at the tree. `size` and `mtimeMs` come from `DocumentFile` and
   * are `Double`s on the JS side; `-1` means the provider didn't supply a
   * value, which expo-file-system's SAF impl already tolerates. Returning a
   * flat list (vs. streaming) is fine for v1 — user-picked folders are
   * ~thousands of files, not millions; camera-roll enumeration happens via
   * MediaLibrary in a later phase.
   */
  private fun walkTree(treeUri: String): List<Map<String, Any>> {
    val parsed = Uri.parse(treeUri)
    val root = DocumentFile.fromTreeUri(context, parsed)
      ?: throw HashException("not a SAF tree uri: $treeUri")
    if (!root.exists() || !root.isDirectory) {
      throw HashException("tree not accessible or not a directory: $treeUri")
    }

    val out = ArrayList<Map<String, Any>>()
    val stack = ArrayDeque<Pair<DocumentFile, String>>()
    stack.addLast(root to "")
    while (stack.isNotEmpty()) {
      val (dir, prefix) = stack.removeLast()
      for (child in dir.listFiles()) {
        val name = child.name ?: continue
        val rel = if (prefix.isEmpty()) name else "$prefix/$name"
        when {
          child.isDirectory -> stack.addLast(child to rel)
          child.isFile -> out.add(
            mapOf(
              "uri" to child.uri.toString(),
              "relativePath" to rel,
              "size" to child.length().toDouble(),
              "mtimeMs" to child.lastModified().toDouble(),
            ),
          )
          else -> { /* broken document — skip */ }
        }
      }
    }
    return out
  }

  private fun encodeTruncated(md: MessageDigest): String {
    val full = md.digest() // 64 bytes
    val sliced = full.copyOfRange(0, CHUNK_HASH_BYTES)
    return Base64.encodeToString(sliced, B64_FLAGS)
  }
}

private class HashException(message: String) : CodedException(message)
