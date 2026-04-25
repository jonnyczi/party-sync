import { describe, expect, it } from 'vitest';

import type { JobRow } from '@/src/db/types';
import {
  isJobDueForPeriodic,
  nextPeriodicRunAt,
  PERIODIC_MIN_INTERVAL_MIN,
} from '@/src/sync/scheduler';

type SchedInputs = Pick<JobRow, 'periodic_enabled' | 'periodic_minutes'>;

const enabled = (minutes: number): SchedInputs => ({
  periodic_enabled: 1,
  periodic_minutes: minutes,
});
const disabled: SchedInputs = {
  periodic_enabled: 0,
  periodic_minutes: 60,
};

describe('isJobDueForPeriodic', () => {
  const NOW = 1_000_000_000_000;
  const MIN = 60_000;

  it('is never due when periodic is disabled', () => {
    expect(isJobDueForPeriodic(disabled, null, NOW)).toBe(false);
    expect(isJobDueForPeriodic(disabled, NOW - 99 * 60 * MIN, NOW)).toBe(false);
  });

  it('is due when enabled and no prior run exists', () => {
    expect(isJobDueForPeriodic(enabled(30), null, NOW)).toBe(true);
  });

  it('is not due within interval', () => {
    expect(isJobDueForPeriodic(enabled(30), NOW - 29 * MIN, NOW)).toBe(false);
  });

  it('is due exactly at the interval boundary', () => {
    expect(isJobDueForPeriodic(enabled(30), NOW - 30 * MIN, NOW)).toBe(true);
  });

  it('is due past the interval', () => {
    expect(isJobDueForPeriodic(enabled(30), NOW - 60 * MIN, NOW)).toBe(true);
  });

  it('clamps to the WorkManager floor even if job asks for less', () => {
    // With 5-min requested cadence, the effective interval is 15 min.
    expect(
      isJobDueForPeriodic(enabled(5), NOW - 14 * MIN, NOW),
    ).toBe(false);
    expect(
      isJobDueForPeriodic(enabled(5), NOW - PERIODIC_MIN_INTERVAL_MIN * MIN, NOW),
    ).toBe(true);
  });
});

describe('nextPeriodicRunAt', () => {
  const NOW = 1_000_000_000_000;
  const MIN = 60_000;

  it('returns null when disabled', () => {
    expect(nextPeriodicRunAt(disabled, NOW - MIN, NOW)).toBeNull();
  });

  it('returns now when enabled with no prior run', () => {
    expect(nextPeriodicRunAt(enabled(30), null, NOW)).toBe(NOW);
  });

  it('returns lastRun + interval (respecting the floor)', () => {
    const last = NOW - 5 * MIN;
    expect(nextPeriodicRunAt(enabled(30), last, NOW)).toBe(last + 30 * MIN);
    expect(nextPeriodicRunAt(enabled(5), last, NOW)).toBe(
      last + PERIODIC_MIN_INTERVAL_MIN * MIN,
    );
  });
});
