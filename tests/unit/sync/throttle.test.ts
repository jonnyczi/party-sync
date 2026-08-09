import { describe, expect, it } from 'vitest';

import { MAX_STITCH_BYTES } from '@/src/copyparty/up2k';
import type { BandwidthMode } from '@/src/db/settings';
import {
  MAX_IDLE_MS,
  PacerAbortedError,
  THROTTLED_BATCH_BYTES,
  createPacer,
  type Pacer,
} from '@/src/sync/throttle';

/**
 * Virtual clock: `sleep` advances time instantly, so a test can assert the
 * duty cycle without waiting in real time. `elapsed` is the wall-clock the
 * pacer would have seen.
 */
function harness(opts: {
  mode: BandwidthMode;
  screenOn?: boolean;
  /** How long each simulated POST takes, in virtual ms. */
  postMs?: number;
}) {
  let t = 1_000_000;
  const slept: number[] = [];
  let mode = opts.mode;
  let screenOn = opts.screenOn ?? true;
  const postMs = opts.postMs ?? 100;
  let concurrent = 0;
  let maxConcurrent = 0;

  const pacer: Pacer = createPacer({
    readMode: async () => mode,
    isScreenOn: () => screenOn,
    now: () => t,
    sleep: async (ms, signal) => {
      if (signal?.aborted) throw new PacerAbortedError();
      slept.push(ms);
      t += ms;
    },
  });

  const post = async <T = void>(result?: T): Promise<T> => {
    concurrent++;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await Promise.resolve();
    t += postMs;
    concurrent--;
    return result as T;
  };

  return {
    pacer,
    /** Await once, as runJob does, so the mode is known before the first batch. */
    prime: () => pacer.prime(),
    post,
    slept,
    now: () => t,
    maxConcurrent: () => maxConcurrent,
    setMode: (m: BandwidthMode) => {
      mode = m;
    },
    setScreen: (on: boolean) => {
      screenOn = on;
    },
    /** Advance the clock without doing work (to expire the TTL caches). */
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('pacer — inactive', () => {
  it('does nothing at full speed', async () => {
    const h = harness({ mode: 'full' });
    await h.prime();
    for (let i = 0; i < 5; i++) await h.pacer.run(h.post);
    expect(h.slept).toEqual([]);
    expect(h.pacer.isActive()).toBe(false);
    expect(h.pacer.maxBatchBytes()).toBe(MAX_STITCH_BYTES);
  });

  it('does nothing while the screen is off, even in gentle mode', async () => {
    // The whole point of the screen gate: an overnight sync must run flat out.
    const h = harness({ mode: 'gentle', screenOn: false });
    await h.prime();
    for (let i = 0; i < 5; i++) await h.pacer.run(h.post);
    expect(h.slept).toEqual([]);
    expect(h.pacer.maxBatchBytes()).toBe(MAX_STITCH_BYTES);
  });

  it('does not serialise when inactive', async () => {
    const h = harness({ mode: 'full' });
    await h.prime();
    await Promise.all([h.pacer.run(h.post), h.pacer.run(h.post), h.pacer.run(h.post)]);
    expect(h.maxConcurrent()).toBe(3);
  });

  it('passes the result through', async () => {
    const h = harness({ mode: 'full' });
    await h.prime();
    await expect(h.pacer.run(() => h.post('ok'))).resolves.toBe('ok');
  });
});

describe('pacer — duty cycle', () => {
  it('idles equal to the transfer time at balanced (~50%)', async () => {
    const h = harness({ mode: 'balanced', postMs: 100 });
    await h.prime();
    for (let i = 0; i < 4; i++) await h.pacer.run(h.post);
    // First POST has no debt to pay; each later one waits out the previous.
    expect(h.slept).toEqual([100, 100, 100]);
  });

  it('idles three times the transfer time at gentle (~25%)', async () => {
    const h = harness({ mode: 'gentle', postMs: 100 });
    await h.prime();
    for (let i = 0; i < 4; i++) await h.pacer.run(h.post);
    expect(h.slept).toEqual([300, 300, 300]);
  });

  it('converges on the requested share of wall-clock', async () => {
    const h = harness({ mode: 'balanced', postMs: 100 });
    await h.prime();
    const start = h.now();
    const n = 20;
    for (let i = 0; i < n; i++) await h.pacer.run(h.post);
    const busy = n * 100;
    const total = h.now() - start;
    // 20 posts, 19 idles of 100 → 3900 total, 2000 busy ≈ 51%.
    expect(busy / total).toBeGreaterThan(0.45);
    expect(busy / total).toBeLessThan(0.55);
  });

  it('caps a single idle so a slow POST cannot stall the run', async () => {
    // 30s POST at gentle would owe 90s; the cap keeps it bounded.
    const h = harness({ mode: 'gentle', postMs: 30_000 });
    await h.prime();
    await h.pacer.run(h.post);
    await h.pacer.run(h.post);
    expect(h.slept).toEqual([MAX_IDLE_MS]);
  });
});

describe('pacer — serialisation', () => {
  it('runs one POST at a time while active', async () => {
    // Per-stream duty cycling does not compose (three 50% streams occupy the
    // link 87.5% of the time), so the limit has to serialise.
    const h = harness({ mode: 'balanced', postMs: 100 });
    await h.prime();
    await Promise.all([h.pacer.run(h.post), h.pacer.run(h.post), h.pacer.run(h.post)]);
    expect(h.maxConcurrent()).toBe(1);
  });

  it('keeps the gate usable after a POST throws', async () => {
    const h = harness({ mode: 'balanced' });
    await h.prime();
    await expect(
      h.pacer.run(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    // A wedged mutex here would hang the rest of the run.
    await expect(h.pacer.run(() => h.post('after'))).resolves.toBe('after');
  });
});

describe('pacer — cancellation', () => {
  it('rejects an already-aborted run without calling fn', async () => {
    const h = harness({ mode: 'gentle' });
    await h.prime();
    const ac = new AbortController();
    ac.abort();
    let called = false;
    await expect(
      h.pacer.run(async () => {
        called = true;
      }, ac.signal),
    ).rejects.toBeInstanceOf(PacerAbortedError);
    expect(called).toBe(false);
  });

  it('does not leave queued workers waiting behind a cancelled run', async () => {
    // Without abortable gate acquisition a cancel would sit through the POST
    // ahead of it, one per queued worker.
    const h = harness({ mode: 'gentle', postMs: 100 });
    await h.prime();
    const ac = new AbortController();
    const first = h.pacer.run(h.post, ac.signal);
    const queued = h.pacer.run(h.post, ac.signal);
    ac.abort();
    await expect(queued).rejects.toBeInstanceOf(PacerAbortedError);
    await first.catch(() => {});
  });
});

describe('pacer — live reconfiguration', () => {
  it('picks up a mode change without restarting the run', async () => {
    const h = harness({ mode: 'gentle', postMs: 100 });
    await h.prime();
    await h.pacer.run(h.post);
    await h.pacer.run(h.post);
    expect(h.slept).toEqual([300]);

    h.setMode('full');
    h.advance(4000); // expire the setting TTL
    await h.pacer.run(h.post); // refreshes the cached mode (still gentle)
    await h.pacer.run(h.post);
    // Once 'full' lands the pacer stops idling entirely.
    const after = h.slept.length;
    await h.pacer.run(h.post);
    expect(h.slept.length).toBe(after);
    expect(h.pacer.isActive()).toBe(false);
  });

  it('stops throttling when the screen goes off mid-run', async () => {
    const h = harness({ mode: 'gentle', postMs: 100 });
    await h.prime();
    await h.pacer.run(h.post);
    await h.pacer.run(h.post);
    expect(h.slept.length).toBe(1);

    h.setScreen(false);
    h.advance(3000); // expire the screen TTL
    const before = h.slept.length;
    await h.pacer.run(h.post);
    await h.pacer.run(h.post);
    expect(h.slept.length).toBe(before);
  });

  it('discards stale debt when the limit is lifted', async () => {
    const h = harness({ mode: 'gentle', postMs: 1000 });
    await h.prime();
    await h.pacer.run(h.post); // owes 3000ms
    h.setScreen(false);
    h.advance(3000);
    await h.pacer.run(h.post); // inactive: clears the debt
    h.setScreen(true);
    h.advance(3000);
    await h.pacer.run(h.post); // active again, but starts from zero debt
    expect(h.slept).toEqual([]);
  });
});

describe('pacer — burst size', () => {
  it('shrinks the batch while active and restores it when not', async () => {
    // A POST is unbreakable, so the batch size *is* the burst. 8 MiB at 60Mbps
    // is a ~1.1s full-rate blast, which is what makes video stutter.
    const h = harness({ mode: 'gentle' });
    await h.prime();
    expect(h.pacer.maxBatchBytes()).toBe(THROTTLED_BATCH_BYTES);
    expect(THROTTLED_BATCH_BYTES).toBeLessThan(MAX_STITCH_BYTES);

    h.setScreen(false);
    h.advance(3000);
    expect(h.pacer.maxBatchBytes()).toBe(MAX_STITCH_BYTES);
  });
});
