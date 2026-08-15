package expo.modules.copypartysha512

import android.content.ContentResolver
import android.content.Context
import android.database.Cursor
import android.net.Uri
import android.os.CancellationSignal
import android.os.OperationCanceledException
import android.provider.DocumentsContract
import android.provider.DocumentsContract.Document
import android.util.Log
import java.util.concurrent.atomic.AtomicBoolean

private const val TAG = "CopypartySha512"

/** Every field `DocumentFile` would have re-queried per child, in one row. */
private val CHILD_PROJECTION = arrayOf(
  Document.COLUMN_DOCUMENT_ID,
  Document.COLUMN_DISPLAY_NAME,
  Document.COLUMN_MIME_TYPE,
  Document.COLUMN_SIZE,
  Document.COLUMN_LAST_MODIFIED,
)

/**
 * Files per `onWalkBatch` event. The JNI→JSI conversion runs on the JS thread,
 * so a batch has to stay well inside a frame; 256 entries × 4 fields is ~1 ms.
 * Batching at all is what keeps a 10k-file walk from posting 10k events.
 */
private const val BATCH_SIZE = 256

/** Thrown to unwind the walk when JS asked for a cancel. */
internal class WalkCancelledException : Exception("walk cancelled")

/**
 * Cooperative cancel for one in-flight walk.
 *
 * The flag is what actually stops the loop. The `CancellationSignal` is a bonus
 * for providers that honour it — `ExternalStorageProvider` does not poll it
 * during a query, the same caveat `copyparty-sync`'s `SafProbes` documents.
 */
internal class WalkToken {
  private val cancelled = AtomicBoolean(false)
  val signal = CancellationSignal()

  fun cancel() {
    cancelled.set(true)
    runCatching { signal.cancel() }
  }

  fun throwIfCancelled() {
    if (cancelled.get()) throw WalkCancelledException()
  }
}

/**
 * Depth-first walk of a SAF tree: **one `ContentResolver.query` per directory**,
 * with every field read straight off the children cursor.
 *
 * The previous implementation used androidx `DocumentFile`.
 * `TreeDocumentFile.listFiles()` queries the children URI with a
 * `COLUMN_DOCUMENT_ID`-only projection and hands back bare handles, so each of
 * `name` / `isDirectory` / `isFile` / `length()` / `lastModified()` becomes its
 * own `ContentResolver.query` on that child's document URI — five binder round
 * trips per file, ~50,000 for a 10,000-file folder. That was the 1–5 minute
 * "scanning" phase users saw before a single byte uploaded.
 *
 * Semantics are byte-identical to `DocumentFile` on purpose.
 * `src/sync/engine.ts` `isAlreadySynced()` short-circuits on `(size, mtime_ms)`
 * equality against `file_state`, so any drift here re-uploads every file that
 * every existing user already has on their server:
 *
 *   name         getName()      = COLUMN_DISPLAY_NAME, null -> entry skipped
 *   isDirectory  mime == MIME_TYPE_DIR
 *   isFile       mime != null && mime != "" && mime != MIME_TYPE_DIR
 *   size         length()       = queryForLong(COLUMN_SIZE, 0)
 *   mtimeMs      lastModified() = queryForLong(COLUMN_LAST_MODIFIED, 0)
 *
 * Note the last two default to **0, not -1**. The old KDoc on `walkTree`
 * claimed -1 meant "provider did not supply a value". It never did: androidx's
 * `DocumentsContractApi19.queryForLong` passes 0 as the default and its
 * catch-all path returns the same 0.
 *
 * A big directory is not a single binder call either way — the cursor is backed
 * by a `CursorWindow` (2 MB) that refills over binder as you page through it.
 * With five short columns (~200 B/row) one window holds ~10k rows, so this is
 * 1–2 transactions per directory in practice. Don't trim the projection
 * thinking it's already O(1) per directory; the projection is the whole point.
 */
internal class SafTreeWalker(
  private val context: Context,
  private val treeUri: Uri,
  private val token: WalkToken,
  private val onBatch: (List<Map<String, Any>>) -> Unit,
) {
  private val resolver: ContentResolver get() = context.contentResolver

  private val batch = ArrayList<Map<String, Any>>(BATCH_SIZE)
  private val visitedDirs = HashSet<String>()
  private var total = 0

  /** @return the number of FILES emitted. The entries leave via [onBatch]. */
  fun walk(rootDocId: String): Int {
    requireReadableDirectory(rootDocId)

    // (documentId, slash-joined prefix). `removeLast()` keeps the old code's
    // DFS order, so a run cancelled mid-scan covers the same prefix of the
    // tree it used to.
    val stack = ArrayDeque<Pair<String, String>>()
    visitedDirs.add(rootDocId)
    stack.addLast(rootDocId to "")

    while (stack.isNotEmpty()) {
      token.throwIfCancelled()
      val (dirDocId, prefix) = stack.removeLast()
      readChildren(dirDocId, prefix, stack)
    }
    flush()
    return total
  }

  /** `DocumentFile.exists() && isDirectory`, in one query instead of two. */
  private fun requireReadableDirectory(rootDocId: String) {
    val docUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, rootDocId)
    val ok = try {
      resolver.query(
        docUri,
        arrayOf(Document.COLUMN_DOCUMENT_ID, Document.COLUMN_MIME_TYPE),
        null,
        null,
        null,
        token.signal,
      )?.use { c ->
        c.moveToFirst() &&
          c.stringOrNull(c.getColumnIndex(Document.COLUMN_MIME_TYPE)) == Document.MIME_TYPE_DIR
      } ?: false
    } catch (e: OperationCanceledException) {
      throw WalkCancelledException()
    } catch (t: Throwable) {
      // Revoked grant, deleted folder, unmounted volume, crashed provider.
      // DocumentFile.exists() swallows all of these to false; so do we, and the
      // throw below surfaces as a run-level 'stat' failure exactly as before,
      // which is what prompts the UI to offer a re-grant.
      Log.w(TAG, "root document query failed for $docUri", t)
      false
    }
    if (!ok) throw HashException("tree not accessible or not a directory: $treeUri")
  }

  private fun readChildren(
    dirDocId: String,
    prefix: String,
    stack: ArrayDeque<Pair<String, String>>,
  ) {
    val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, dirDocId)
    val cursor: Cursor = try {
      resolver.query(childrenUri, CHILD_PROJECTION, null, null, null, token.signal)
    } catch (e: OperationCanceledException) {
      throw WalkCancelledException()
    } catch (t: Throwable) {
      // TreeDocumentFile.listFiles() logs and returns an empty array on any
      // throw. Matching that means a mid-walk permission loss yields fewer
      // files rather than failing the run — the same posture as today, and safe
      // only because delete-propagation does not exist yet. Revisit this if
      // `jobs.propagate_deletes` ever grows an implementation: a short listing
      // would then read as "the user deleted these".
      Log.w(TAG, "listing failed for $childrenUri", t)
      null
    } ?: return

    cursor.use { c ->
      val iId = c.getColumnIndex(Document.COLUMN_DOCUMENT_ID)
      val iName = c.getColumnIndex(Document.COLUMN_DISPLAY_NAME)
      val iMime = c.getColumnIndex(Document.COLUMN_MIME_TYPE)
      val iSize = c.getColumnIndex(Document.COLUMN_SIZE)
      val iMtime = c.getColumnIndex(Document.COLUMN_LAST_MODIFIED)

      // The document id is the one column DocumentFile itself demands; without
      // it there is no way to address the child at all.
      if (iId < 0) {
        Log.w(TAG, "provider omitted COLUMN_DOCUMENT_ID for $childrenUri")
        return
      }
      // A DocumentsProvider is free to ignore our projection. If it dropped a
      // column we would report size/mtime 0 where DocumentFile's per-document
      // query returned a real value — and that is worse than a re-upload: a 0
      // feeds straight into up2k.ts as `precomputedSize` and uploads an empty
      // file. So fall back to per-child queries for the missing columns only.
      // Decided once per directory, so ExternalStorageProvider (which serves
      // all five) never pays for it.
      val perChild = iName < 0 || iMime < 0 || iSize < 0 || iMtime < 0
      if (perChild) Log.w(TAG, "children cursor short on columns for $childrenUri")

      while (c.moveToNext()) {
        token.throwIfCancelled()
        val docId = c.stringOrNull(iId) ?: continue
        val childUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, docId)

        var name = c.stringOrNull(iName)
        var mime = c.stringOrNull(iMime)
        var size = c.longOrZero(iSize)
        var mtime = c.longOrZero(iMtime)
        if (perChild) {
          if (iName < 0) name = queryForString(childUri, Document.COLUMN_DISPLAY_NAME)
          if (iMime < 0) mime = queryForString(childUri, Document.COLUMN_MIME_TYPE)
          if (iSize < 0) size = queryForLong(childUri, Document.COLUMN_SIZE)
          if (iMtime < 0) mtime = queryForLong(childUri, Document.COLUMN_LAST_MODIFIED)
        }

        if (name == null) continue // DocumentFile: `child.name ?: continue`
        // A display name of "." or ".." would climb out of the remote folder
        // once engine.ts joins it onto job.remote_path. No filesystem or
        // provider produces one, so refusing them costs nothing real.
        if (name == "." || name == "..") continue

        val rel = if (prefix.isEmpty()) name else "$prefix/$name"
        when {
          mime == Document.MIME_TYPE_DIR -> {
            // DocumentFile had no cycle guard: a provider that lists a
            // directory as its own descendant looped the walk forever.
            if (visitedDirs.add(docId)) stack.addLast(docId to rel)
            else Log.w(TAG, "cycle: document $docId revisited at $rel")
          }
          !mime.isNullOrEmpty() -> emit(childUri, rel, size, mtime)
          else -> {
            // Broken document: no mime type. DocumentFile calls it neither file
            // nor directory, and so did the old `else -> {}` branch. Skip.
          }
        }
      }
    }
  }

  private fun emit(childUri: Uri, rel: String, size: Long, mtime: Long) {
    batch.add(
      mapOf(
        "uri" to childUri.toString(),
        "relativePath" to rel,
        "size" to size.toDouble(),
        "mtimeMs" to mtime.toDouble(),
      ),
    )
    total++
    if (batch.size >= BATCH_SIZE) flush()
  }

  private fun flush() {
    if (batch.isEmpty()) return
    onBatch(ArrayList(batch))
    batch.clear()
  }

  // --- androidx DocumentsContractApi19 equivalents, for the fallback path ---

  private fun queryForString(uri: Uri, column: String): String? = try {
    resolver.query(uri, arrayOf(column), null, null, null, token.signal)?.use { c ->
      if (c.moveToFirst()) c.stringOrNull(0) else null
    }
  } catch (e: OperationCanceledException) {
    throw WalkCancelledException()
  } catch (t: Throwable) {
    Log.w(TAG, "failed query $column on $uri", t)
    null
  }

  private fun queryForLong(uri: Uri, column: String): Long = try {
    resolver.query(uri, arrayOf(column), null, null, null, token.signal)?.use { c ->
      if (c.moveToFirst()) c.longOrZero(0) else 0L
    } ?: 0L
  } catch (e: OperationCanceledException) {
    throw WalkCancelledException()
  } catch (t: Throwable) {
    Log.w(TAG, "failed query $column on $uri", t)
    0L
  }
}

/** null for an absent column, a null value, or a provider that throws —
 *  matching `DocumentsContractApi19.queryForString`'s catch-all. */
private fun Cursor.stringOrNull(idx: Int): String? =
  if (idx < 0 || isNull(idx)) null else runCatching { getString(idx) }.getOrNull()

/** 0 for an absent column, a null value, or a throw. **0, not -1** — see the
 *  class KDoc; this default is load-bearing for dedup. */
private fun Cursor.longOrZero(idx: Int): Long =
  if (idx < 0 || isNull(idx)) 0L else runCatching { getLong(idx) }.getOrDefault(0L)
