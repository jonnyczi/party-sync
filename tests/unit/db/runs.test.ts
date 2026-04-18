import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createJob } from '@/src/db/jobs';
import {
  finishRun,
  getLatestRunForJob,
  getRun,
  listRunErrors,
  listRunsForJob,
  recordRunError,
  startRun,
  updateRunCounters,
} from '@/src/db/runs';
import { runMigrations } from '@/src/db/schema';
import { createServer } from '@/src/db/servers';

import { createTestDb } from './adapter';

let db: ReturnType<typeof createTestDb>;
let jobId: number;

beforeEach(async () => {
  db = createTestDb();
  await runMigrations(db);
  const serverId = await createServer(db, { name: 's', base_url: 'https://s' });
  jobId = await createJob(db, {
    server_id: serverId,
    name: 'j',
    source_kind: 'saf',
    source_uri: 'x',
    remote_path: '/r',
  });
});
afterEach(() => {
  db.close();
});

describe('runs DAO', () => {
  it('starts a run in running state with zeroed counters', async () => {
    const runId = await startRun(db, { job_id: jobId, trigger: 'manual' });
    const row = await getRun(db, runId);
    expect(row?.status).toBe('running');
    expect(row?.trigger).toBe('manual');
    expect(row?.finished_at).toBeNull();
    expect(row?.files_scanned).toBe(0);
    expect(row?.bytes_uploaded).toBe(0);
  });

  it('updateRunCounters only touches provided fields', async () => {
    const runId = await startRun(db, { job_id: jobId, trigger: 'manual' });
    await updateRunCounters(db, runId, {
      files_scanned: 5,
      bytes_uploaded: 1000,
    });
    await updateRunCounters(db, runId, { files_uploaded: 3 });
    const row = await getRun(db, runId);
    expect(row?.files_scanned).toBe(5);
    expect(row?.bytes_uploaded).toBe(1000);
    expect(row?.files_uploaded).toBe(3);
    expect(row?.files_failed).toBe(0);
  });

  it('finishRun sets finished_at, status, and merges counters', async () => {
    const runId = await startRun(db, { job_id: jobId, trigger: 'periodic' });
    await finishRun(db, runId, {
      status: 'partial',
      files_uploaded: 7,
      files_failed: 1,
    });
    const row = await getRun(db, runId);
    expect(row?.status).toBe('partial');
    expect(row?.finished_at).not.toBeNull();
    expect(row?.files_uploaded).toBe(7);
    expect(row?.files_failed).toBe(1);
  });

  it('listRunsForJob orders most-recent first', async () => {
    const a = await startRun(db, { job_id: jobId, trigger: 'manual' });
    await new Promise((r) => setTimeout(r, 2));
    const b = await startRun(db, { job_id: jobId, trigger: 'manual' });
    const rows = await listRunsForJob(db, jobId);
    expect(rows.map((r) => r.id)).toEqual([b, a]);
    expect((await getLatestRunForJob(db, jobId))?.id).toBe(b);
  });

  it('records and lists run errors', async () => {
    const runId = await startRun(db, { job_id: jobId, trigger: 'manual' });
    await recordRunError(db, {
      run_id: runId,
      local_path: 'a',
      phase: 'upload',
      http_status: 500,
      message: 'boom',
    });
    await recordRunError(db, {
      run_id: runId,
      local_path: 'b',
      phase: 'hash',
    });
    const errs = await listRunErrors(db, runId);
    expect(errs).toHaveLength(2);
    expect(errs[0].phase).toBe('upload');
    expect(errs[0].http_status).toBe(500);
    expect(errs[1].http_status).toBeNull();
  });

  it('run_errors cascade on run delete', async () => {
    const runId = await startRun(db, { job_id: jobId, trigger: 'manual' });
    await recordRunError(db, { run_id: runId, local_path: 'a', phase: 'hash' });
    await db.runAsync('DELETE FROM runs WHERE id = ?', [runId]);
    expect(await listRunErrors(db, runId)).toHaveLength(0);
  });
});
