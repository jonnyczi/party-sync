import type { RunRow } from '../db/types';

export interface DayBucket {
  day: string;
  bytes: number;
}

export interface RunAgg {
  uploaded: number;
  failed: number;
  bytes: number;
}

function localDayKey(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Returns `days` contiguous local-day buckets ending at `now`'s local day.
 * Empty days are zero-filled so the caller (a bar chart) can assume a
 * fixed-length series. Runs outside the window are ignored.
 *
 * Local time is deliberate — users think in local days. Pass an explicit
 * `now` so tests don't depend on wall clock.
 */
export function bucketBytesByDay(
  runs: Pick<RunRow, 'started_at' | 'bytes_uploaded'>[],
  days: number,
  now: number,
): DayBucket[] {
  const end = new Date(now);
  end.setHours(0, 0, 0, 0);
  const buckets: DayBucket[] = [];
  const index = new Map<string, number>();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(end.getTime());
    d.setDate(d.getDate() - i);
    const key = localDayKey(d.getTime());
    index.set(key, buckets.length);
    buckets.push({ day: key, bytes: 0 });
  }
  for (const r of runs) {
    const key = localDayKey(r.started_at);
    const i = index.get(key);
    if (i === undefined) continue;
    buckets[i].bytes += r.bytes_uploaded;
  }
  return buckets;
}

export function aggregateRuns(
  runs: Pick<RunRow, 'files_uploaded' | 'files_failed' | 'bytes_uploaded'>[],
): RunAgg {
  const agg: RunAgg = { uploaded: 0, failed: 0, bytes: 0 };
  for (const r of runs) {
    agg.uploaded += r.files_uploaded;
    agg.failed += r.files_failed;
    agg.bytes += r.bytes_uploaded;
  }
  return agg;
}
