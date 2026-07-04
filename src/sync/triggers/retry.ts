import { CopypartyClient } from '../../copyparty/client';
import { nativeFileSource } from '../../copyparty/hash.native';
import type { SqliteDb } from '../../db/adapter';
import { getJob } from '../../db/jobs';
import { getRun, listRunFailedPaths } from '../../db/runs';
import { getServer } from '../../db/servers';
import type { RunRow } from '../../db/types';
import { getServerPassword } from '../../storage/secrets';
import { runJob } from '../engine';
import { withForegroundService } from '../foreground';
import { notifyRunResult } from '../notify-result';
import { defaultProgressBus } from '../progress';

import { resolveWalker } from './manual';

/**
 * Re-run a job scoped to one prior run's failed files. Builds the set of failed
 * local paths from that run's `run_errors` (excluding wholesale failures) and
 * passes it to the engine as `filterPaths`, so only those files are scanned and
 * attempted; the engine's `(size, mtime)` short-circuit still skips anything
 * already uploaded. Runs through the same foreground-service + `defaultProgressBus`
 * path as a manual run so it shows live in the UI. Returns the new `RunRow`.
 */
export async function retryRunFailures(
  db: SqliteDb,
  runId: number,
): Promise<RunRow> {
  const run = await getRun(db, runId);
  if (!run) throw new Error(`run ${runId} not found`);

  const failed = await listRunFailedPaths(db, runId);
  if (failed.length === 0) {
    throw new Error(`run ${runId} has no failed files to retry`);
  }

  const job = await getJob(db, run.job_id);
  if (!job) throw new Error(`job ${run.job_id} for run ${runId} not found`);

  const server = await getServer(db, job.server_id);
  if (!server) throw new Error(`server ${job.server_id} for job ${job.id} not found`);

  const walker = await resolveWalker(job);

  const password = await getServerPassword(server.id);
  const client = new CopypartyClient({
    baseUrl: server.base_url,
    password: password ?? undefined,
    username: server.username ?? undefined,
  });

  const result = await withForegroundService(job.name, () =>
    runJob(
      {
        db,
        walker,
        client,
        fileSource: nativeFileSource,
        progress: defaultProgressBus,
        filterPaths: new Set(failed),
      },
      job.id,
      'retry',
    ),
  );
  await notifyRunResult(db, result, job);
  return result;
}
