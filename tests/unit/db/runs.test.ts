import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createJob } from '@/src/db/jobs';
import {
  countRunErrors,
  finishRun,
  getLatestRunForJob,
  getRun,
  listRecentErrors,
  listRunErrors,
  listRunsForJob,
  listRunsSince,
  recordRunError,
  recordSkippedRun,
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

  it('countRunErrors returns 0 when none, exact count otherwise', async () => {
    const runId = await startRun(db, { job_id: jobId, trigger: 'manual' });
    expect(await countRunErrors(db, runId)).toBe(0);
    await recordRunError(db, { run_id: runId, local_path: 'a', phase: 'hash' });
    await recordRunError(db, { run_id: runId, local_path: 'b', phase: 'upload' });
    expect(await countRunErrors(db, runId)).toBe(2);
  });

  it('listRunsSince filters by started_at, orders DESC, respects limit', async () => {
    const oldRun = await startRun(db, { job_id: jobId, trigger: 'manual' });
    // Back-date the first run so it falls outside the window.
    await db.runAsync('UPDATE runs SET started_at = ? WHERE id = ?', [
      1000,
      oldRun,
    ]);
    await new Promise((r) => setTimeout(r, 2));
    const a = await startRun(db, { job_id: jobId, trigger: 'manual' });
    await new Promise((r) => setTimeout(r, 2));
    const b = await startRun(db, { job_id: jobId, trigger: 'manual' });

    const rows = await listRunsSince(db, 2000);
    expect(rows.map((r) => r.id)).toEqual([b, a]);

    const limited = await listRunsSince(db, 2000, 1);
    expect(limited.map((r) => r.id)).toEqual([b]);
  });

  it('listRecentErrors joins job name and orders by run time then id DESC', async () => {
    const jobId2 = await createJob(db, {
      server_id: (await db.getFirstAsync<{ id: number }>(
        'SELECT id FROM servers LIMIT 1',
        [],
      ))!.id,
      name: 'j2',
      source_kind: 'saf',
      source_uri: 'y',
      remote_path: '/r2',
    });

    const runA = await startRun(db, { job_id: jobId, trigger: 'manual' });
    await db.runAsync('UPDATE runs SET started_at = ? WHERE id = ?', [1000, runA]);
    await recordRunError(db, {
      run_id: runA,
      local_path: 'old1',
      phase: 'upload',
      http_status: 500,
    });
    await recordRunError(db, {
      run_id: runA,
      local_path: 'old2',
      phase: 'hash',
    });

    const runB = await startRun(db, { job_id: jobId2, trigger: 'manual' });
    await db.runAsync('UPDATE runs SET started_at = ? WHERE id = ?', [5000, runB]);
    await recordRunError(db, {
      run_id: runB,
      local_path: 'new',
      phase: 'handshake',
      message: 'bad',
    });

    const rows = await listRecentErrors(db, 10);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      local_path: 'new',
      job_name: 'j2',
      run_started_at: 5000,
      phase: 'handshake',
    });
    // Same-run errors: newer error id first.
    expect(rows[1]).toMatchObject({ local_path: 'old2', job_name: 'j' });
    expect(rows[2]).toMatchObject({ local_path: 'old1', job_name: 'j' });

    const limited = await listRecentErrors(db, 2);
    expect(limited).toHaveLength(2);
    expect(limited[0].local_path).toBe('new');
  });

  it('recordSkippedRun writes an instantaneous row with skip_reason', async () => {
    const id = await recordSkippedRun(db, {
      job_id: jobId,
      trigger: 'periodic',
      skip_reason: 'wifi_only',
    });
    const row = await getRun(db, id);
    expect(row?.status).toBe('skipped');
    expect(row?.trigger).toBe('periodic');
    expect(row?.skip_reason).toBe('wifi_only');
    expect(row?.started_at).toBe(row?.finished_at);
    expect(row?.files_scanned).toBe(0);
    expect(row?.files_uploaded).toBe(0);
    expect(row?.files_failed).toBe(0);
    expect(row?.bytes_uploaded).toBe(0);
  });

  it('skipped runs appear in listRunsForJob / getLatestRunForJob', async () => {
    const first = await startRun(db, { job_id: jobId, trigger: 'manual' });
    await finishRun(db, first, { status: 'ok' });
    await new Promise((r) => setTimeout(r, 2));
    const skipped = await recordSkippedRun(db, {
      job_id: jobId,
      trigger: 'periodic',
      skip_reason: 'charging_only',
    });
    const latest = await getLatestRunForJob(db, jobId);
    expect(latest?.id).toBe(skipped);
    const all = await listRunsForJob(db, jobId);
    expect(all[0].id).toBe(skipped);
  });
});
