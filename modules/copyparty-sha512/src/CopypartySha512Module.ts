import { NativeModule, requireNativeModule } from 'expo';

import { CopypartySha512ModuleEvents } from './CopypartySha512.types';

declare class CopypartySha512Module extends NativeModule<CopypartySha512ModuleEvents> {
  /**
   * Stream the file at `uri` (content://, file://, or absolute path) and
   * return one base64url chunk hash per chunk, in order. Each hash is the
   * first 33 bytes of SHA-512(chunk) base64url-encoded with no padding,
   * matching copyparty's wire format (44 chars per hash).
   */
  hashFileChunks(uri: string, chunksize: number): Promise<string[]>;

  /** Read bytes in [car, cdr) from `uri`. Returns the chunk for an upload POST. */
  readRange(uri: string, car: number, cdr: number): Promise<Uint8Array>;

  /** Resolve the size in bytes of `uri`. */
  size(uri: string): Promise<number>;

  /**
   * Sizes for a whole page of URIs in one round trip. Prefer this to looping
   * over {@link size}: for plain MediaStore item URIs it collapses to one
   * MediaStore query per collection, so a 10k-asset camera roll costs a handful
   * of queries instead of 10k of them plus 10k bridge hops.
   *
   * Returns one entry per input URI, in order. An entry is
   * {@link SIZE_UNAVAILABLE} when that asset vanished between enumeration and
   * stat, or the provider had no size — a per-item failure never fails the
   * batch, so the caller drops only that file.
   */
  sizes(uris: string[]): Promise<number[]>;

  /**
   * Walk a SAF tree URI, streaming files to the `onWalkBatch` event.
   *
   * Directories are recursed into and not emitted. Entries arrive as
   * {@link SafWalkBatchEvent} batches *while the walk is still running*, which
   * is what lets the engine's scan counters advance live and its cancel land
   * mid-walk; the promise itself resolves with the file count (or
   * {@link WALK_CANCELLED}), not the entries.
   *
   * `walkId` must be unique per call and is echoed in every event.
   *
   * Android-only; iOS parity is deferred with the rest of iOS support.
   */
  walkTree(treeUri: string, walkId: string): Promise<number>;

  /**
   * Stop the in-flight {@link walkTree} with this id. Unknown ids are a no-op,
   * so calling it unconditionally on teardown is safe.
   */
  cancelWalk(walkId: string): void;

  /**
   * Map a source URI to the one that yields the file's *original* bytes.
   *
   * For MediaStore camera-roll URIs on Android 10+ this asks for the
   * unredacted original, which requires ACCESS_MEDIA_LOCATION; without that
   * permission Android zero-fills the EXIF GPS block in place, so the bytes we
   * read differ from the file on disk while keeping the same length. Returns
   * the input unchanged for file:// paths, SAF URIs, and when the permission
   * isn't held.
   *
   * Resolve once per file and pass the result to `hashFileChunks`/`readRange`
   * together: mixing a resolved and an unresolved URI for the same file would
   * upload chunks that don't match the hashes we handshaked.
   */
  resolveReadUri(uri: string): Promise<string>;

  /**
   * {@link resolveReadUri} for a whole page in one round trip. Returns one entry
   * per input URI, in order. There is no ContentResolver query on this path —
   * the per-asset cost was the bridge hop plus a permission check whose answer
   * cannot vary across a page, so the batch hoists it out of the loop.
   */
  resolveReadUris(uris: string[]): Promise<string[]>;
}

export default requireNativeModule<CopypartySha512Module>('CopypartySha512');
