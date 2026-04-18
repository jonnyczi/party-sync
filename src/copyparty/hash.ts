/**
 * `FileSource` is the platform-agnostic surface up2k uses to read and hash
 * a local file. Hashing and ranged reads are co-located because both
 * implementations naturally own the underlying file handle:
 *
 * - On Android (device) the implementation lives in `hash.native.ts` and
 *   delegates to the `copyparty-sha512` native module, which streams the
 *   file via Android's ContentResolver and hashes it natively.
 * - In Node (vitest, integration tests) the implementation lives in
 *   `hash.node.ts` and uses `node:fs` + `node:crypto`.
 *
 * Both implementations MUST emit hashes that are byte-identical to
 * copyparty's web client: SHA-512 truncated to the first 33 bytes, then
 * base64url-encoded with no padding (44 chars per hash).
 */
export interface FileSource {
  /**
   * Stream the file at `uri` and return one base64url chunk hash per chunk
   * (in order). `chunksize` comes from `up2kChunksize(size)` so that the
   * resulting list is interchangeable with copyparty's web client.
   */
  hashFileChunks(uri: string, chunksize: number): Promise<string[]>;

  /**
   * Read bytes in `[car, cdr)` from the file at `uri`. Used to build the
   * body of a chunk POST during the upload phase.
   */
  readRange(uri: string, car: number, cdr: number): Promise<Uint8Array>;

  /** File size in bytes. */
  size(uri: string): Promise<number>;
}
