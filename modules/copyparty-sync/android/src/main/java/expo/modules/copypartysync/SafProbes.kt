package expo.modules.copypartysync

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.CancellationSignal
import android.provider.DocumentsContract
import android.util.Log

/**
 * Is a persisted SAF tree grant still usable?
 *
 * The JS answer — `StorageAccessFramework.readDirectoryAsync`, i.e.
 * `DocumentFile.listFiles()` — enumerates every child of the tree and marshals
 * one URI string per file across the bridge, so "can this job still read its
 * folder?" costs O(children): seconds on a camera roll. The question only ever
 * needed the tree's *own* document row, so this asks for exactly that: one
 * column, one row. androidx's `DocumentFile.exists()` is the reference
 * implementation; this is it, plus a grant check and a CancellationSignal
 * (which the androidx helper has no overload for).
 *
 * Known limit, deliberately accepted: a third-party DocumentsProvider (a cloud
 * storage app) could serve a cached row and report readable when a subsequent
 * read fails. That is **not** a regression — `readDirectoryAsync` goes through
 * the same provider via `queryChildDocuments` and can be lied to identically.
 * Do not "fix" it by reinstating the enumeration.
 *
 * Consumed by src/storage/saf.ts, which falls back to the JS enumeration when
 * this function is missing from an older binary.
 */
object SafProbes {
  private const val TAG = "CopypartySync"

  /**
   * @return true when the tree is readable, false when it definitively is not.
   *   "Did not answer" is the caller's problem — see the timeout wrapped around
   *   this in CopypartySyncModule.
   */
  fun canReadFolder(context: Context, treeUriString: String, signal: CancellationSignal): Boolean {
    val treeUri = runCatching { Uri.parse(treeUriString) }.getOrNull() ?: return false
    if (!DocumentsContract.isTreeUri(treeUri)) return false

    // 1. Is the grant itself still held? This is the "Android dropped the
    //    persisted grants" / "app data cleared" case, and answering it needs no
    //    round trip to the storage provider — so it can never hang, and the
    //    cheapest failure to detect becomes the fastest one.
    if (!holdsReadGrant(context, treeUri)) return false

    // 2. Does the folder still exist and answer? A moved, renamed or deleted
    //    folder no longer resolves to a document row, and an unmounted volume
    //    has no root for the document id. DocumentsProvider.query() swallows
    //    the resulting FileNotFoundException and hands back a null cursor,
    //    which is the same signal androidx relies on.
    val docId = runCatching { DocumentsContract.getTreeDocumentId(treeUri) }.getOrNull()
      ?: return false
    val docUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, docId)

    return try {
      context.contentResolver.query(
        docUri,
        arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID),
        null,
        null,
        null,
        signal,
      ).use { it != null && it.count > 0 }
    } catch (t: Throwable) {
      // SecurityException = the grant went away between step 1 and here.
      // Anything else = a provider misbehaving. Both mean "not readable".
      Log.w(TAG, "tree document query failed for $treeUri", t)
      false
    }
  }

  private fun holdsReadGrant(context: Context, treeUri: Uri): Boolean {
    // expo-file-system takes a persistable grant at pick time, so this is the
    // authoritative check for a folder job's stored source_uri.
    val persisted = context.contentResolver.persistedUriPermissions
      .any { it.isReadPermission && it.uri == treeUri }
    if (persisted) return true

    // A grant taken this session but not yet persisted still works. Checked
    // against the *tree* URI, where the grant literally lives — checking a
    // tree-derived document URI instead would lean on
    // DocumentsProvider.checkUriPermission, which only exists from API 29.
    return context.checkCallingOrSelfUriPermission(
      treeUri,
      Intent.FLAG_GRANT_READ_URI_PERMISSION,
    ) == PackageManager.PERMISSION_GRANTED
  }
}
