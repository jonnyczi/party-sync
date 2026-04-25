import * as MediaLibrary from 'expo-media-library';

import { CopypartyClient } from '../../copyparty/client';
import { nativeFileSource } from '../../copyparty/hash.native';
import type { SqliteDb } from '../../db/adapter';
import { getJob } from '../../db/jobs';
import { getServer } from '../../db/servers';
import type { JobRow, RunRow } from '../../db/types';
import { getServerPassword } from '../../storage/secrets';
import { runJob } from '../engine';
import { withForegroundService } from '../foreground';
import { defaultProgressBus } from '../progress';
import { mediaWalker } from '../walker/media';
import { safWalker } from '../walker/saf';
import type { SourceWalker } from '../walker/types';

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

  const walker = await resolveWalker(job);

  const password = await getServerPassword(server.id);
  const client = new CopypartyClient({
    baseUrl: server.base_url,
    password: password ?? undefined,
  });

  return withForegroundService(job.name, () =>
    runJob(
      {
        db,
        walker,
        client,
        fileSource: nativeFileSource,
        progress: defaultProgressBus,
      },
      jobId,
      'manual',
    ),
  );
}

/**
 * Pick the walker and, for media jobs, acquire the MediaLibrary permission
 * up-front. A missing permission becomes a thrown error here (not a
 * per-file error) so the UI can prompt the user without the engine ever
 * starting a run. The engine only sees the walker throw if permission was
 * revoked mid-run, which surfaces as a `stat`-phase wholesale failure —
 * same posture as SAF revocation.
 */
async function resolveWalker(job: JobRow): Promise<SourceWalker> {
  if (job.source_kind === 'saf') return safWalker;
  if (job.source_kind === 'media') {
    const perm = await MediaLibrary.requestPermissionsAsync(false, ['photo', 'video']);
    if (perm.status !== 'granted') {
      throw new Error(
        'Camera-roll permission denied. Grant Photos & Videos in system settings.',
      );
    }
    return mediaWalker;
  }
  const unreachable: never = job.source_kind;
  throw new Error(`unknown source_kind: ${String(unreachable)}`);
}
