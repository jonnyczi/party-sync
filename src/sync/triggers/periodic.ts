import { CopypartyClient } from '../../copyparty/client';
import { nativeFileSource } from '../../copyparty/hash.native';
import type { SqliteDb } from '../../db/adapter';
import { listJobs } from '../../db/jobs';
import { getLatestRunForJob, recordSkippedRun } from '../../db/runs';
import { getServer } from '../../db/servers';
import type { JobRow } from '../../db/types';
import { hasMediaReadPermission } from '../../media/media-permission';
import { getServerPassword } from '../../storage/secrets';
import { evaluateConstraints } from '../constraints';
import { readConstraintState } from '../device-state';
import { runJob } from '../engine';
import { withForegroundService } from '../foreground';
import { notifyRunResult } from '../notify-result';
import { defaultProgressBus } from '../progress';
import { isJobDueForPeriodic } from '../scheduler';
import { mediaWalker } from '../walker/media';
import { safWalker } from '../walker/saf';
import type { SourceWalker } from '../walker/types';

/**
 * Body of the WorkManager periodic task. Runs eligible jobs sequentially;
 * writes a `skipped` run row for jobs that are due but gated by
 * constraints or by an active manual run.
 *
 * All errors are caught per-job so one flaky job doesn't abort the tick
 * for the rest. Unexpected errors are logged and surfaced as a
 * `recordSkippedRun` with reason="already_running" would be wrong — we
 * just log and continue, leaving the job's state untouched so the next
 * tick tries again cleanly.
 */
export async function runPeriodicTick(db: SqliteDb): Promise<void> {
  const now = Date.now();
  const jobs = await listJobs(db);
  const eligible: JobRow[] = [];

  for (const job of jobs) {
    if (!job.periodic_enabled) continue;
    const latest = await getLatestRunForJob(db, job.id);
    if (!isJobDueForPeriodic(job, latest?.started_at ?? null, now)) continue;
    eligible.push(job);
  }

  if (eligible.length === 0) return;

  // If a manual run is in flight, every due job is skipped with the same
  // reason. The progress bus is single-slot — starting another run here
  // would clobber the live UI state.
  if (defaultProgressBus.getSnapshot().activeRun !== null) {
    for (const job of eligible) {
      await recordSkippedRun(db, {
        job_id: job.id,
        trigger: 'periodic',
        skip_reason: 'already_running',
      });
    }
    return;
  }

  const state = await readConstraintState();

  for (const job of eligible) {
    const decision = evaluateConstraints(job, state);
    if (!decision.pass) {
      await recordSkippedRun(db, {
        job_id: job.id,
        trigger: 'periodic',
        skip_reason: decision.reason,
      });
      continue;
    }

    try {
      await runPeriodicJob(db, job);
    } catch (e) {
      // runJob itself catches per-file errors and records them as
      // run_errors; an exception at this level means something above
      // that layer failed (server lookup, password read, walker init).
      // Log and move on — the next tick retries.
      console.warn(
        `[copyparty] periodic run for job ${job.id} failed`,
        e,
      );
    }
  }
}

async function runPeriodicJob(db: SqliteDb, job: JobRow): Promise<void> {
  const server = await getServer(db, job.server_id);
  if (!server) {
    console.warn(
      `[copyparty] periodic: server ${job.server_id} for job ${job.id} missing`,
    );
    return;
  }

  const walker = await resolveWalker(job);
  const password = await getServerPassword(server.id);
  const client = new CopypartyClient({
    baseUrl: server.base_url,
    password: password ?? undefined,
    username: server.username ?? undefined,
  });

  const run = await withForegroundService(job.name, () =>
    runJob(
      {
        db,
        walker,
        client,
        fileSource: nativeFileSource,
        progress: defaultProgressBus,
      },
      job.id,
      'periodic',
    ),
    defaultProgressBus,
  );
  // Best-effort: a failed notification must not abort the periodic loop.
  try {
    await notifyRunResult(db, run, job);
  } catch (e) {
    console.warn(`[copyparty] result notification for job ${job.id} failed`, e);
  }
}

/**
 * Periodic triggers cannot prompt for permissions — if the user revoked
 * camera-roll access since creating the job, the walker will throw on
 * first use, surfacing as a stat-phase run failure. No interactive
 * recovery is possible from a background task.
 */
async function resolveWalker(job: JobRow): Promise<SourceWalker> {
  if (job.source_kind === 'saf') return safWalker;
  if (job.source_kind === 'media') {
    // Deliberately not MediaLibrary.getPermissionsAsync: it AND-aggregates
    // ACCESS_MEDIA_LOCATION, which a pre-existing install has never been asked
    // for — that would report "not granted" and silently kill background sync.
    if (!(await hasMediaReadPermission())) {
      throw new Error(
        'Camera-roll permission is not granted; skipping periodic run.',
      );
    }
    return mediaWalker;
  }
  const unreachable: never = job.source_kind;
  throw new Error(`unknown source_kind: ${String(unreachable)}`);
}
