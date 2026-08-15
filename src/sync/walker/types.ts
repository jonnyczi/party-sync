/**
 * One enumerated file from a sync source. `localPath` is the stable key the
 * engine stores in `file_state.local_path` — its job is to be invariant
 * across runs so (size, mtime) short-circuits work. For SAF sources that's
 * the relative path under the tree root; for media sources (phase 4) it'll
 * be a MediaStore row id.
 *
 * `uri` is the opaque handle passed to `FileSource.{hashFileChunks,readRange,size}`
 * — a content:// URI on Android, a filesystem path in Node tests. It may carry
 * per-read decoration that `localPath` must not (the media walker resolves
 * MediaStore URIs to their unredacted-original form), so never persist it or
 * use it as a key.
 */
export interface WalkerEntry {
  localPath: string;
  uri: string;
  /**
   * Slash-joined path from the source root. Used to reconstruct the remote
   * folder (remote_path + dirname(relativePath)) and filename (basename).
   */
  relativePath: string;
  size: number;
  mtimeMs: number;
}

export interface SourceWalker {
  /**
   * Enumerate the source. Implementations MUST yield entries lazily: the engine
   * publishes its scan counters and polls for cancellation between yields, so a
   * walker that buffers the whole tree before yielding leaves the UI frozen on
   * "Scanning…" and makes Cancel a no-op for the duration. Both walkers stream —
   * SAF via native batch events, media via MediaStore pages.
   */
  walk(sourceUri: string): AsyncIterable<WalkerEntry>;
}
