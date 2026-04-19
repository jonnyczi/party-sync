import { CopypartyClient } from '../../copyparty/client';
import { nativeFileSource } from '../../copyparty/hash.native';
import type { SqliteDb } from '../../db/adapter';
import { getJob } from '../../db/jobs';
import { getServer } from '../../db/servers';
import type { RunRow } from '../../db/types';
import { getServerPassword } from '../../storage/secrets';
import { runJob } from '../engine';
import { defaultProgressBus } from '../progress';
import { safWalker } from '../walker/saf';

/**
 * Resolve a job's server + password, build a CopypartyClient, and run the
 * sync engine once. Invoked from the UI's "Sync now" button. Returns when
 * the run finishes (success, partial, or failed) — the UI awaits the
 * promise only to know when to clear its local "running" flag; live
 * progress is delivered via `defaultProgressBus`.
 */
export async function runJobManual(
  db: SqliteDb,
  jobId: number,
): Promise<RunRow> {
  const job = await getJob(db, jobId);
  if (!job) throw new Error(`job ${jobId} not found`);

  const server = await getServer(db, job.server_id);
  if (!server) throw new Error(`server ${job.server_id} for job ${jobId} not found`);

  const password = await getServerPassword(server.id);
  const client = new CopypartyClient({
    baseUrl: server.base_url,
    password: password ?? undefined,
  });

  return runJob(
    {
      db,
      walker: safWalker,
      client,
      fileSource: nativeFileSource,
      progress: defaultProgressBus,
    },
    jobId,
    'manual',
  );
}
