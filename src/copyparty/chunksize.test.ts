import { describe, expect, it } from 'vitest';
import { chunkRanges, up2kChunksize } from './chunksize';

const MIB = 1024 * 1024;

describe('up2kChunksize', () => {
  it('returns 1 MiB for tiny files', () => {
    expect(up2kChunksize(0)).toBe(1 * MIB);
    expect(up2kChunksize(1)).toBe(1 * MIB);
    expect(up2kChunksize(1 * MIB)).toBe(1 * MIB);
  });

  it('keeps 1 MiB up to the 256-chunk boundary', () => {
    expect(up2kChunksize(256 * MIB)).toBe(1 * MIB);
  });

  it('grows past the 1 MiB / 256 chunk boundary', () => {
    expect(up2kChunksize(257 * MIB)).toBeGreaterThan(1 * MIB);
  });

  it('matches the canonical step sequence', () => {
    // The first six step values in the python loop are:
    //   chunksize starts 1 MiB, stepsize starts 0.5 MiB
    //   mul=1: chunksize += 0.5 MiB -> 1.5 MiB; stepsize *= 1 -> 0.5 MiB
    //   mul=2: chunksize += 0.5 MiB -> 2.0 MiB; stepsize *= 2 -> 1.0 MiB
    //   mul=1: chunksize += 1.0 MiB -> 3.0 MiB; stepsize *= 1 -> 1.0 MiB
    //   mul=2: chunksize += 1.0 MiB -> 4.0 MiB; stepsize *= 2 -> 2.0 MiB
    //   mul=1: chunksize += 2.0 MiB -> 6.0 MiB
    //   mul=2: chunksize += 2.0 MiB -> 8.0 MiB; stepsize *= 2 -> 4.0 MiB
    // Pick file sizes that force each step.
    expect(up2kChunksize(257 * MIB)).toBe(1.5 * MIB);
    expect(up2kChunksize(Math.floor(1.5 * MIB) * 256 + 1)).toBe(2 * MIB);
  });

  it('returns >= 32 MiB once the 4096-chunk regime kicks in for huge files', () => {
    // 100 GiB
    const huge = 100 * 1024 * MIB;
    const cs = up2kChunksize(huge);
    expect(cs).toBeGreaterThanOrEqual(32 * MIB);
    expect(Math.ceil(huge / cs)).toBeLessThanOrEqual(4096);
  });
});

describe('chunkRanges', () => {
  it('produces contiguous, non-overlapping ranges that cover the file', () => {
    const ranges = chunkRanges(10 * MIB + 123, 4 * MIB);
    expect(ranges).toEqual([
      { car: 0, cdr: 4 * MIB },
      { car: 4 * MIB, cdr: 8 * MIB },
      { car: 8 * MIB, cdr: 10 * MIB + 123 },
    ]);
  });

  it('returns an empty list for an empty file', () => {
    expect(chunkRanges(0, 1 * MIB)).toEqual([]);
  });
});
