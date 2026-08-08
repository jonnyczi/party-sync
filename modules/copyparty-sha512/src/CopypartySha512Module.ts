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
   * Walk a SAF tree URI and return one entry per FILE under it. Directories
   * are recursed into and not emitted. `relativePath` is slash-joined under
   * the tree root (never starts with `/`). `mtimeMs` is the provider's last-
   * modified value (0 / -1 if not supplied). Android-only; iOS parity is
   * deferred with the rest of iOS support.
   */
  walkTree(treeUri: string): Promise<SafWalkEntry[]>;

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
}

export interface SafWalkEntry {
  uri: string;
  relativePath: string;
  size: number;
  mtimeMs: number;
}

export default requireNativeModule<CopypartySha512Module>('CopypartySha512');
