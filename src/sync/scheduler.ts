import type { JobRow } from '../db/types';

export const PERIODIC_TASK_NAME = 'copyparty-periodic';

/**
 * WorkManager's hard floor for periodic work. Even if a user asks for
 * `periodic_minutes=5`, the OS will coalesce to 15. We enforce the same
 * floor at the UI layer and at task registration; per-job cadences above
 * 15 are respected by the `isJobDueForPeriodic` gate inside the tick.
 */
export const PERIODIC_MIN_INTERVAL_MIN = 15;

/**
 * Is this job due for a periodic tick right now?
 *
 * `lastRunStartedAt` is the most recent run **regardless of status** —
 * including `skipped` rows. Gate by tick cadence, not by success cadence,
 * so a job stuck on cellular doesn't get a fresh tick every 15 minutes
 * on top of the base cadence.
 */
export function isJobDueForPeriodic(
  job: Pick<JobRow, 'periodic_enabled' | 'periodic_minutes'>,
  lastRunStartedAt: number | null,
  now: number,
): boolean {
  if (!job.periodic_enabled) return false;
  if (lastRunStartedAt === null) return true;
  const intervalMs = Math.max(
    PERIODIC_MIN_INTERVAL_MIN,
    job.periodic_minutes,
  ) * 60_000;
  return now - lastRunStartedAt >= intervalMs;
}

/**
 * "Next run" timestamp for the UI — `null` if not scheduled.
 */
export function nextPeriodicRunAt(
  job: Pick<JobRow, 'periodic_enabled' | 'periodic_minutes'>,
  lastRunStartedAt: number | null,
  now: number,
): number | null {
  if (!job.periodic_enabled) return null;
  if (lastRunStartedAt === null) return now;
  const intervalMs = Math.max(
    PERIODIC_MIN_INTERVAL_MIN,
    job.periodic_minutes,
  ) * 60_000;
  return lastRunStartedAt + intervalMs;
}
