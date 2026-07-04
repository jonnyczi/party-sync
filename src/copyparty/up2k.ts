import { up2kChunksize } from './chunksize';
import type { CopypartyClient } from './client';
import type { FileSource } from './hash';
import type { HandshakeResponse } from './types';
import { Up2kError } from './types';

const MAX_REHANDSHAKES = 10;

/**
 * Chunk-stitching caps. copyparty accepts several whole chunks in one POST
 * (comma-joined hashes in `X-Up2k-Hash`, body = those chunks' bytes
 * concatenated) which cuts request overhead dramatically on multi-chunk
 * files. We cap a stitched POST so the in-memory `fetch` body stays modest on
 * a phone: at most {@link MAX_STITCH_CHUNKS} chunks or {@link MAX_STITCH_BYTES}
 * bytes, whichever is hit first. A single chunk is always sent even if it
 * alone exceeds the byte cap (large-file chunksizes can be >8 MiB), so this
 * only ever reduces request count versus the one-chunk-per-POST baseline.
 *
 * Note: this is NOT `X-Up2k-Subc`. That header is copyparty's opposite
 * feature — splitting one oversized chunk into resumable sub-chunks — and the
 * server rejects it whenever more than one chunk is in the request.
 */
export const MAX_STITCH_BYTES = 8 * 1024 * 1024;
export const MAX_STITCH_CHUNKS = 8;

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
  /**
   * Optional abort signal for the run. Threaded into every handshake/chunk POST
   * so a cancel (or per-request timeout) tears the transfer down mid-flight.
   */
  signal?: AbortSignal;
}

export interface UploadResult {
  wark: string;
  /** Final folder path the file landed in (server may rename). */
  remoteFolder: string;
  /** Final filename (server may rename). */
  name: string;
  bytesUploaded: number;
  /**
   * Bytes we did NOT have to send because the server already had them
   * (`size - bytesUploaded`). Equals the full `size` when the file already
   * existed in its entirety. This is the per-file "saved via dedup" figure
   * the engine sums into `runs.bytes_deduped`.
   */
  dedupSavedBytes: number;
  /** True if the server already had every chunk on the initial handshake. */
  alreadyExisted: boolean;
}

/** One stitched POST: a contiguous run of missing chunks. */
export interface ChunkBatch {
  /** Chunk hashes in ascending-ordinal order (comma-joined for the header). */
  hashes: string[];
  /** Inclusive byte offset of the first chunk. */
  car: number;
  /** Exclusive byte offset of the last chunk (clamped to file size). */
  cdr: number;
}

/**
 * Group the server's missing-chunk hashes into stitched POST batches.
 *
 * Each unique missing hash is mapped to its first ordinal in `allHashes`
 * (copyparty returns a duplicate chunk's hash once and clones it server-side,
 * so we upload each unique hash a single time). Ordinals are then sorted and
 * grouped into maximal *contiguous* runs, split whenever the run would exceed
 * {@link MAX_STITCH_CHUNKS} chunks or {@link MAX_STITCH_BYTES} bytes. A
 * contiguous run maps to one on-disk byte range, so each batch is a single
 * `readRange`.
 *
 * Exported for unit testing.
 */
export function planStitchedChunks(
  missing: string[],
  allHashes: string[],
  chunksize: number,
  size: number,
): ChunkBatch[] {
  const ordinals: number[] = [];
  const seen = new Set<number>();
  for (const h of missing) {
    const idx = allHashes.indexOf(h);
    if (idx < 0) {
      throw new Up2kError(
        `server requested hash ${h} not in our chunk list`,
        'upload',
      );
    }
    if (!seen.has(idx)) {
      seen.add(idx);
      ordinals.push(idx);
    }
  }
  ordinals.sort((a, b) => a - b);

  const batches: ChunkBatch[] = [];
  let i = 0;
  while (i < ordinals.length) {
    const startOrd = ordinals[i];
    let endOrd = startOrd;
    let j = i;
    // Grow the batch over consecutive ordinals while it stays under the caps.
    // A single chunk is always allowed (the caps only limit growth).
    while (j + 1 < ordinals.length && ordinals[j + 1] === ordinals[j] + 1) {
      const nextEnd = ordinals[j + 1];
      const count = nextEnd - startOrd + 1;
      const car = startOrd * chunksize;
      const cdr = Math.min((nextEnd + 1) * chunksize, size);
      if (count > MAX_STITCH_CHUNKS || cdr - car > MAX_STITCH_BYTES) break;
      j++;
      endOrd = nextEnd;
    }
    const car = startOrd * chunksize;
    const cdr = Math.min((endOrd + 1) * chunksize, size);
    const hashes: string[] = [];
    for (let k = startOrd; k <= endOrd; k++) hashes.push(allHashes[k]);
    batches.push({ hashes, car, cdr });
    i = j + 1;
  }
  return batches;
}

/**
 * up2k upload state machine. Per `docs/initial-plan.md` "Sync pipeline":
 *
 *   handshake → upload missing chunks → re-handshake → repeat until empty
 *
 * Missing chunks are stitched into batched POSTs (see
 * {@link planStitchedChunks}); intra-file concurrency stays at one POST in
 * flight — engine-level concurrency goes across files, not within them.
 */
export async function uploadFile(opts: UploadOptions): Promise<UploadResult> {
  const { client, fileSource, localUri, lmod, onProgress, signal } = opts;
  const size = opts.precomputedSize ?? (await fileSource.size(localUri));
  const chunksize = up2kChunksize(size);
  const hashes =
    opts.precomputedHashes ?? (await fileSource.hashFileChunks(localUri, chunksize));

  let folder = opts.remoteFolder;
  let name = opts.name;

  let response = (await client.handshake(
    folder,
    {
      name,
      size,
      lmod,
      hash: hashes,
    },
    signal,
  )) as HandshakeResponse;

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

    const batches = planStitchedChunks(response.hash, hashes, chunksize, size);
    for (const batch of batches) {
      const body = await fileSource.readRange(localUri, batch.car, batch.cdr);
      await client.uploadChunk(folder, { hash: batch.hashes.join(','), wark }, body, signal);
      bytesUploaded += batch.cdr - batch.car;
      onProgress?.({ bytesUploaded, totalBytes: size });
    }

    response = (await client.handshake(
      folder,
      {
        name,
        size,
        lmod,
        hash: hashes,
      },
      signal,
    )) as HandshakeResponse;
    if (response.purl) folder = response.purl;
    if (response.name) name = response.name;
  }

  return {
    wark,
    remoteFolder: folder,
    name,
    bytesUploaded,
    dedupSavedBytes: Math.max(0, size - bytesUploaded),
    alreadyExisted,
  };
}
