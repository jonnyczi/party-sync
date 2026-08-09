import { describe, expect, it } from 'vitest';

import {
  MAX_STITCH_BYTES,
  MAX_STITCH_CHUNKS,
  planStitchedChunks,
} from '@/src/copyparty/up2k';
import { Up2kError } from '@/src/copyparty/types';

const MIB = 1024 * 1024;

/** Build ['h0', 'h1', ... 'h{n-1}']. */
function hashes(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `h${i}`);
}

describe('planStitchedChunks', () => {
  it('stitches a contiguous run of missing chunks into one batch', () => {
    const all = hashes(3);
    const size = 2.5 * MIB; // 3 chunks @ 1 MiB, last is a 0.5 MiB tail
    const batches = planStitchedChunks(all, all, MIB, size);

    expect(batches).toHaveLength(1);
    expect(batches[0].hashes).toEqual(['h0', 'h1', 'h2']);
    expect(batches[0].car).toBe(0);
    expect(batches[0].cdr).toBe(size); // clamped to the file's real end
  });

  it('honours a smaller maxStitchBytes from the bandwidth limiter', () => {
    // A POST is unbreakable, so the batch size sets the smallest burst the
    // throttle can enforce (see src/sync/throttle.ts).
    const all = hashes(8);
    const size = 8 * MIB;
    const batches = planStitchedChunks(all, all, MIB, size, 2 * MIB);

    expect(batches).toHaveLength(4);
    for (const b of batches) expect(b.cdr - b.car).toBeLessThanOrEqual(2 * MIB);
    // Still covers the whole file, in order, with no gaps.
    expect(batches[0].car).toBe(0);
    expect(batches[batches.length - 1].cdr).toBe(size);
  });

  it('still emits a single chunk larger than the cap', () => {
    // Sub-chunking needs X-Up2k-Subc, which we deliberately do not use, so a
    // large-file chunksize is an irreducible burst.
    const all = hashes(2);
    const chunksize = 16 * MIB;
    const batches = planStitchedChunks(all, all, chunksize, 32 * MIB, MIB);

    expect(batches).toHaveLength(2);
    expect(batches[0].cdr - batches[0].car).toBe(chunksize);
  });

  it('splits when a contiguous run exceeds the chunk-count cap', () => {
    const n = MAX_STITCH_CHUNKS + 2; // 10
    const all = hashes(n);
    const cs = 64 * 1024; // small, so the byte cap is never the limit
    const size = n * cs;
    const batches = planStitchedChunks(all, all, cs, size);

    expect(batches).toHaveLength(2);
    expect(batches[0].hashes).toHaveLength(MAX_STITCH_CHUNKS);
    expect(batches[1].hashes).toHaveLength(n - MAX_STITCH_CHUNKS);
    expect(batches[0].cdr - batches[0].car).toBe(MAX_STITCH_CHUNKS * cs);
  });

  it('splits when a contiguous run exceeds the byte cap', () => {
    const cs = 3 * MIB; // two chunks = 6 MiB ok, three = 9 MiB > 8 MiB cap
    const all = hashes(4);
    const size = 4 * cs;
    const batches = planStitchedChunks(all, all, cs, size);

    expect(batches).toHaveLength(2);
    expect(batches[0].hashes).toEqual(['h0', 'h1']);
    expect(batches[1].hashes).toEqual(['h2', 'h3']);
    for (const b of batches) {
      expect(b.cdr - b.car).toBeLessThanOrEqual(MAX_STITCH_BYTES);
    }
  });

  it('always sends a lone chunk even when it alone exceeds the byte cap', () => {
    const cs = 16 * MIB; // one chunk > 8 MiB cap
    const all = hashes(2);
    const size = 2 * cs;
    const batches = planStitchedChunks(all, all, cs, size);

    expect(batches).toHaveLength(2);
    expect(batches[0].hashes).toEqual(['h0']);
    expect(batches[1].hashes).toEqual(['h1']);
  });

  it('breaks a batch at a gap of non-missing chunks', () => {
    const all = hashes(3);
    const size = 3 * MIB;
    // chunk 1 already on the server → only 0 and 2 are missing
    const batches = planStitchedChunks(['h0', 'h2'], all, MIB, size);

    expect(batches).toHaveLength(2);
    expect(batches[0]).toMatchObject({ hashes: ['h0'], car: 0, cdr: MIB });
    expect(batches[1]).toMatchObject({ hashes: ['h2'], car: 2 * MIB, cdr: size });
  });

  it('orders by ordinal regardless of the order the server lists missing hashes', () => {
    const all = hashes(3);
    const batches = planStitchedChunks(['h2', 'h0', 'h1'], all, MIB, 3 * MIB);
    expect(batches).toHaveLength(1);
    expect(batches[0].hashes).toEqual(['h0', 'h1', 'h2']);
  });

  it('uploads a duplicate chunk hash once (server clones the rest)', () => {
    // chunk 2 has the same content as chunk 0; copyparty returns the hash once.
    const all = ['h0', 'h1', 'h0'];
    const batches = planStitchedChunks(['h0', 'h1'], all, MIB, 3 * MIB);
    expect(batches).toHaveLength(1);
    expect(batches[0].hashes).toEqual(['h0', 'h1']);
    expect(batches[0].car).toBe(0);
    expect(batches[0].cdr).toBe(2 * MIB);
  });

  it('throws when the server asks for a hash we do not have', () => {
    const all = hashes(2);
    expect(() => planStitchedChunks(['nope'], all, MIB, 2 * MIB)).toThrow(Up2kError);
  });
});
