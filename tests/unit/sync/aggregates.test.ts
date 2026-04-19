import { describe, expect, it } from 'vitest';

import { aggregateRuns, bucketBytesByDay } from '@/src/sync/aggregates';

function t(y: number, m: number, d: number, h = 12): number {
  return new Date(y, m - 1, d, h, 0, 0, 0).getTime();
}

describe('bucketBytesByDay', () => {
  it('returns `days` buckets ending at now\'s local day', () => {
    const now = t(2026, 4, 19);
    const b = bucketBytesByDay([], 7, now);
    expect(b).toHaveLength(7);
    expect(b[6].day).toBe('2026-04-19');
    expect(b[0].day).toBe('2026-04-13');
    expect(b.every((x) => x.bytes === 0)).toBe(true);
  });

  it('sums multiple runs in the same day', () => {
    const now = t(2026, 4, 19);
    const runs = [
      { started_at: t(2026, 4, 19, 9), bytes_uploaded: 100 },
      { started_at: t(2026, 4, 19, 14), bytes_uploaded: 50 },
      { started_at: t(2026, 4, 17, 3), bytes_uploaded: 25 },
    ];
    const b = bucketBytesByDay(runs, 7, now);
    expect(b[6].bytes).toBe(150);
    expect(b[4].bytes).toBe(25);
    expect(b[5].bytes).toBe(0);
  });

  it('ignores runs outside the window', () => {
    const now = t(2026, 4, 19);
    const runs = [
      { started_at: t(2026, 4, 1), bytes_uploaded: 999 },
      { started_at: t(2026, 4, 19), bytes_uploaded: 10 },
    ];
    const b = bucketBytesByDay(runs, 7, now);
    expect(b.reduce((s, x) => s + x.bytes, 0)).toBe(10);
  });

  it('handles a 1-day window', () => {
    const now = t(2026, 4, 19);
    const b = bucketBytesByDay(
      [{ started_at: t(2026, 4, 19), bytes_uploaded: 7 }],
      1,
      now,
    );
    expect(b).toEqual([{ day: '2026-04-19', bytes: 7 }]);
  });
});

describe('aggregateRuns', () => {
  it('returns zeros for an empty slice', () => {
    expect(aggregateRuns([])).toEqual({ uploaded: 0, failed: 0, bytes: 0 });
  });

  it('sums fields independently', () => {
    const agg = aggregateRuns([
      { files_uploaded: 3, files_failed: 1, bytes_uploaded: 1000 },
      { files_uploaded: 5, files_failed: 0, bytes_uploaded: 2000 },
      { files_uploaded: 0, files_failed: 2, bytes_uploaded: 0 },
    ]);
    expect(agg).toEqual({ uploaded: 8, failed: 3, bytes: 3000 });
  });
});
