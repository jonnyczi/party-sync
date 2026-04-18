import { up2kChunksize } from './chunksize';
import type { CopypartyClient } from './client';
import type { FileSource } from './hash';
import type { HandshakeResponse } from './types';
import { Up2kError } from './types';

const MAX_REHANDSHAKES = 10;

export interface UploadOptions {
  client: CopypartyClient;
  fileSource: FileSource;
  /** Local URI/path passed straight through to the FileSource. */
  localUri: string;
  /** Filename presented to the server. */
  name: string;
  /** Folder path on the server (e.g. "/phone-backups/jonny/"). */
  remoteFolder: string;
  /** Last modified time in unix seconds. */
  lmod: number;
  /** Pre-computed chunk hashes from a prior run. We hash if absent. */
  precomputedHashes?: string[];
  /** Pre-computed file size. Avoids one stat round-trip. */
  precomputedSize?: number;
  /** Optional progress callback after each chunk POST. */
  onProgress?: (info: { bytesUploaded: number; totalBytes: number }) => void;
}

export interface UploadResult {
  wark: string;
  /** Final folder path the file landed in (server may rename). */
  remoteFolder: string;
  /** Final filename (server may rename). */
  name: string;
  bytesUploaded: number;
  /** True if the server already had every chunk on the initial handshake. */
  alreadyExisted: boolean;
}

/**
 * up2k upload state machine. Per `docs/initial-plan.md` "Sync pipeline":
 *
 *   handshake → upload missing chunks → re-handshake → repeat until empty
 *
 * v1 ships one chunk per POST (no stitching) and 1 chunk in flight per file
 * (engine-level concurrency goes across files, not within them). Stitching
 * and intra-file concurrency are deferred until we measure throughput.
 */
export async function uploadFile(opts: UploadOptions): Promise<UploadResult> {
  const { client, fileSource, localUri, lmod, onProgress } = opts;
  const size = opts.precomputedSize ?? (await fileSource.size(localUri));
  const chunksize = up2kChunksize(size);
  const hashes =
    opts.precomputedHashes ?? (await fileSource.hashFileChunks(localUri, chunksize));

  let folder = opts.remoteFolder;
  let name = opts.name;

  let response = (await client.handshake(folder, {
    name,
    size,
    lmod,
    hash: hashes,
  })) as HandshakeResponse;

  if (response.purl) folder = response.purl;
  if (response.name) name = response.name;

  const wark = response.wark;
  const alreadyExisted = response.hash.length === 0;
  let bytesUploaded = 0;
  let iterations = 0;

  while (response.hash.length > 0) {
    if (iterations++ >= MAX_REHANDSHAKES) {
      throw new Up2kError(
        `re-handshake loop did not converge after ${MAX_REHANDSHAKES} iterations`,
        'finalize',
      );
    }

    for (const missingHash of response.hash) {
      const idx = hashes.indexOf(missingHash);
      if (idx < 0) {
        throw new Up2kError(
          `server requested hash ${missingHash} not in our chunk list`,
          'upload',
        );
      }
      const car = idx * chunksize;
      const cdr = Math.min(car + chunksize, size);
      const body = await fileSource.readRange(localUri, car, cdr);
      await client.uploadChunk(folder, { hash: missingHash, wark }, body);
      bytesUploaded += cdr - car;
      onProgress?.({ bytesUploaded, totalBytes: size });
    }

    response = (await client.handshake(folder, {
      name,
      size,
      lmod,
      hash: hashes,
    })) as HandshakeResponse;
    if (response.purl) folder = response.purl;
    if (response.name) name = response.name;
  }

  return { wark, remoteFolder: folder, name, bytesUploaded, alreadyExisted };
}
