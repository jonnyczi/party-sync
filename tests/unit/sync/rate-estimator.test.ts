import { describe, expect, it } from 'vitest';

import {
  RateEstimator,
  formatEta,
  formatRate,
  type RateEstimate,
} from '@/src/sync/rate-estimator';

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const HOUR_MS = 60 * 60 * 1000;

const START = 1_000_000;

/**
 * Feed the estimator one sample per second for `seconds`, advancing wire and
 * progress bytes by the given per-second deltas. Returns the final estimate.
 */
function feed(
  est: RateEstimator,
  opts: {
    seconds: number;
    wirePerSec: number;
    /** Defaults to `wirePerSec` — i.e. no dedup, all bytes on the wire. */
    progressPerSec?: number;
    totalBytes: number;
    /** Carried-in state so a test can run several phases back to back. */
    state?: { wire: number; progress: number; t: number };
  },
): { estimate: RateEstimate; state: { wire: number; progress: number; t: number } } {
  const progressPerSec = opts.progressPerSec ?? opts.wirePerSec;
  const state = opts.state ?? { wire: 0, progress: 0, t: START };
  let estimate: RateEstimate = {
    rateBytesPerSec: null,
    etaMs: null,
    capped: false,
    stalled: false,
  };
  for (let i = 0; i < opts.seconds; i++) {
    state.t += 1000;
    state.wire += opts.wirePerSec;
    state.progress += progressPerSec;
    estimate = est.sample({
      wireBytes: state.wire,
      progressBytes: state.progress,
      totalBytes: opts.totalBytes,
      startedAt: START,
      now: state.t,
    });
  }
  return { estimate, state };
}

describe('RateEstimator', () => {
  it('reports steady wire throughput', () => {
    const est = new RateEstimator();
    const { estimate } = feed(est, {
      seconds: 20,
      wirePerSec: 4 * MIB,
      totalBytes: 400 * MIB,
    });
    expect(estimate.rateBytesPerSec).toBeCloseTo(4 * MIB, -3);
    // 400 MiB total, 80 MiB done at 4 MiB/s → 320 MiB / 4 MiB/s = 80s.
    expect(estimate.etaMs! / 1000).toBeCloseTo(80, 0);
    expect(estimate.stalled).toBe(false);
    expect(estimate.capped).toBe(false);
  });

  it('does not report a dedup lump as wire throughput', () => {
    // Regression: uploadedBytes credits a deduped file in one sample, so
    // deriving the rate from it reported ~1 GiB/s and collapsed the ETA to
    // seconds. The wire numerator must ignore the lump entirely.
    const est = new RateEstimator();
    const { state } = feed(est, {
      seconds: 15,
      wirePerSec: 2 * MIB,
      totalBytes: 8 * GIB,
    });

    // One sample in which a 1 GiB file deduped: progress jumps, wire does not.
    state.t += 1000;
    state.progress += GIB;
    const estimate = est.sample({
      wireBytes: state.wire,
      progressBytes: state.progress,
      totalBytes: 8 * GIB,
      startedAt: START,
      now: state.t,
    });

    // Speed stays in the neighbourhood of the real 2 MiB/s, nowhere near GiB/s.
    expect(estimate.rateBytesPerSec).toBeLessThan(4 * MIB);
    expect(estimate.rateBytesPerSec).toBeGreaterThan(MIB);
  });

  it('keeps the ETA bounded through a long stall instead of exploding', () => {
    // Regression: the old EMA decayed as 0.7^k on zero-delta samples, so ~40s
    // of stillness divided the rate by ~10^6 and the ETA read in the millions
    // of hours. Nothing here may exceed the 24h ceiling.
    const est = new RateEstimator();
    const { state, estimate: healthy } = feed(est, {
      seconds: 20,
      wirePerSec: 4 * MIB,
      totalBytes: 400 * MIB,
    });
    expect(healthy.etaMs).toBeLessThan(5 * 60 * 1000);

    // 60s of absolutely no movement (hashing a huge file / retry backoff).
    const stalledRun = feed(est, {
      seconds: 60,
      wirePerSec: 0,
      totalBytes: 400 * MIB,
      state,
    });

    expect(stalledRun.estimate.stalled).toBe(true);
    // Either held at the last good value or dropped — never an absurd number.
    if (stalledRun.estimate.etaMs !== null) {
      expect(stalledRun.estimate.etaMs).toBeLessThanOrEqual(24 * HOUR_MS);
    }
    expect(formatEta(stalledRun.estimate)).not.toMatch(/\d{4,}h/);
  });

  it('holds the last ETA during a short stall, then drops it', () => {
    const est = new RateEstimator();
    const { state, estimate: healthy } = feed(est, {
      seconds: 20,
      wirePerSec: 4 * MIB,
      totalBytes: 400 * MIB,
    });

    // 20s of stillness: past the stall threshold, short of the drop threshold.
    // The value must be the one from before the stall, untouched — recomputing
    // while nothing moves is exactly what used to inflate it.
    const held = feed(est, { seconds: 20, wirePerSec: 0, totalBytes: 400 * MIB, state });
    expect(held.estimate.stalled).toBe(true);
    expect(held.estimate.etaMs).toBe(healthy.etaMs);
    expect(healthy.etaMs).not.toBeNull();

    // Past the drop threshold there is no honest estimate left to give.
    const dropped = feed(est, {
      seconds: 45,
      wirePerSec: 0,
      totalBytes: 400 * MIB,
      state: held.state,
    });
    expect(dropped.estimate.etaMs).toBeNull();
    expect(formatEta(dropped.estimate)).toBe('stalled');
  });

  it('lets a genuine slowdown lengthen the ETA', () => {
    // The floor must bound a stall without flattening a real slowdown — this
    // is what keeps the ETA honest once the bandwidth limiter starts cutting
    // the rate on purpose.
    const est = new RateEstimator();
    const fast = feed(est, { seconds: 20, wirePerSec: 8 * MIB, totalBytes: 2 * GIB });
    const slow = feed(est, {
      seconds: 40,
      wirePerSec: 0.8 * MIB,
      totalBytes: 2 * GIB,
      state: fast.state,
    });

    expect(slow.estimate.stalled).toBe(false);
    // Clearly slower than before, and in the right ballpark for ~0.8 MiB/s.
    expect(slow.estimate.etaMs!).toBeGreaterThan(fast.estimate.etaMs! * 2);
    expect(slow.estimate.rateBytesPerSec!).toBeLessThan(2 * MIB);
  });

  it('caps an implausibly long ETA rather than printing it', () => {
    const est = new RateEstimator();
    // 40 KiB/s against a 100 GiB job → ~30 days. (Fast enough to clear the
    // MIN_BYTES gate; slow enough that the honest answer is unprintable.)
    const { estimate } = feed(est, {
      seconds: 20,
      wirePerSec: 40 * 1024,
      totalBytes: 100 * GIB,
    });
    expect(estimate.capped).toBe(true);
    expect(estimate.etaMs).toBe(24 * HOUR_MS);
    expect(formatEta(estimate)).toBe('over a day left');
  });

  it('suppresses the ETA until there is enough history', () => {
    const est = new RateEstimator();
    const { estimate } = feed(est, { seconds: 2, wirePerSec: 4 * MIB, totalBytes: GIB });
    expect(estimate.etaMs).toBeNull();
  });

  it('reports no ETA when the denominator is unknown', () => {
    const est = new RateEstimator();
    const { estimate } = feed(est, { seconds: 20, wirePerSec: 4 * MIB, totalBytes: 0 });
    expect(estimate.etaMs).toBeNull();
  });

  it('reset clears history between runs', () => {
    const est = new RateEstimator();
    feed(est, { seconds: 20, wirePerSec: 8 * MIB, totalBytes: GIB });
    est.reset();
    const { estimate } = feed(est, { seconds: 1, wirePerSec: MIB, totalBytes: GIB });
    expect(estimate.etaMs).toBeNull();
    expect(estimate.rateBytesPerSec).toBeNull();
  });
});

describe('formatters', () => {
  it('formats rates, treating zero as nothing to show', () => {
    expect(formatRate(null)).toBe('');
    expect(formatRate(0)).toBe('');
    expect(formatRate(512)).toBe('512 B/s');
    expect(formatRate(64 * 1024)).toBe('64 KiB/s');
    expect(formatRate(4.2 * MIB)).toBe('4.2 MiB/s');
  });

  it('formats ETAs across the ranges', () => {
    const base = { rateBytesPerSec: 1, capped: false, stalled: false };
    expect(formatEta({ ...base, etaMs: null })).toBe('');
    expect(formatEta({ ...base, etaMs: 45_000 })).toBe('~45s left');
    expect(formatEta({ ...base, etaMs: 3 * 60_000 })).toBe('~3m left');
    expect(formatEta({ ...base, etaMs: 80 * 60_000 })).toBe('~1h 20m left');
    expect(formatEta({ ...base, etaMs: 120 * 60_000 })).toBe('~2h left');
    expect(formatEta({ ...base, etaMs: 25 * HOUR_MS, capped: true })).toBe(
      'over a day left',
    );
  });
});
