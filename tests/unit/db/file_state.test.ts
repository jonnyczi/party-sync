import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  deleteFileState,
  getFileState,
  listFileStateForJob,
  listSyncedFileStateForJob,
  upsertFileState,
} from '@/src/db/file_state';
import { createJob } from '@/src/db/jobs';
import { runMigrations } from '@/src/db/schema';
import { createServer } from '@/src/db/servers';

import { createTestDb } from './adapter';

let db: ReturnType<typeof createTestDb>;
let jobId: number;
let serverId: number;

beforeEach(async () => {
  db = createTestDb();
  await runMigrations(db);
  serverId = await createServer(db, { name: 's', base_url: 'https://s' });
  jobId = await createJob(db, {
    server_id: serverId,
    name: 'j',
    source_kind: 'saf',
    source_uri: 'content://tree',
    remote_path: '/r',
  });
});
afterEach(() => {
  db.close();
});

describe('file_state DAO', () => {
  it('upsert inserts then updates the same composite key', async () => {
    await upsertFileState(db, {
      job_id: jobId,
      local_path: 'a/b.jpg',
      size: 1024,
      mtime_ms: 100,
    });
    let row = await getFileState(db, jobId, 'a/b.jpg');
    expect(row?.size).toBe(1024);
    expect(row?.wark).toBeNull();

    await upsertFileState(db, {
      job_id: jobId,
      local_path: 'a/b.jpg',
      size: 2048,
      mtime_ms: 200,
      wark: 'warkvalue',
      last_hashed_at: 300,
      uploaded_at: 400,
    });
    row = await getFileState(db, jobId, 'a/b.jpg');
    expect(row?.size).toBe(2048);
    expect(row?.mtime_ms).toBe(200);
    expect(row?.wark).toBe('warkvalue');
    expect(row?.uploaded_at).toBe(400);

    const rows = await listFileStateForJob(db, jobId);
    expect(rows).toHaveLength(1);
  });

  it('different (job, path) are independent', async () => {
    await upsertFileState(db, {
      job_id: jobId,
      local_path: 'x',
      size: 1,
      mtime_ms: 1,
    });
    await upsertFileState(db, {
      job_id: jobId,
      local_path: 'y',
      size: 2,
      mtime_ms: 2,
    });
    const rows = await listFileStateForJob(db, jobId);
    expect(rows).toHaveLength(2);
  });

  it('deleteFileState removes a specific row', async () => {
    await upsertFileState(db, {
      job_id: jobId,
      local_path: 'gone',
      size: 1,
      mtime_ms: 1,
    });
    await deleteFileState(db, jobId, 'gone');
    expect(await getFileState(db, jobId, 'gone')).toBeNull();
  });

  it('cascades when job is deleted', async () => {
    await upsertFileState(db, {
      job_id: jobId,
      local_path: 'x',
      size: 1,
      mtime_ms: 1,
    });
    await db.runAsync('DELETE FROM jobs WHERE id = ?', [jobId]);
    const rows = await listFileStateForJob(db, jobId);
    expect(rows).toHaveLength(0);
  });

  describe('listSyncedFileStateForJob', () => {
    it('returns only uploaded rows, with only the skip-decision columns', async () => {
      await upsertFileState(db, {
        job_id: jobId,
        local_path: 'sent.bin',
        size: 10,
        mtime_ms: 20,
        wark: 'w',
        last_hashed_at: 5,
        uploaded_at: 6,
      });
      // Hashed by a prior run but never fully sent — still needs work, so it
      // must not appear as a skip candidate.
      await upsertFileState(db, {
        job_id: jobId,
        local_path: 'half-sent.bin',
        size: 30,
        mtime_ms: 40,
        wark: 'w2',
        last_hashed_at: 5,
        uploaded_at: null,
      });

      const rows = await listSyncedFileStateForJob(db, jobId);

      expect(rows).toEqual([{ local_path: 'sent.bin', size: 10, mtime_ms: 20 }]);
      // `wark` is 44 chars a row and is read nowhere; a 10k-file job used to
      // carry it across the bridge on every single run.
      expect(rows[0]).not.toHaveProperty('wark');
    });

    it('is scoped to the job', async () => {
      const otherJobId = await createJob(db, {
        server_id: serverId,
        name: 'other',
        source_kind: 'saf',
        source_uri: 'content://other',
        remote_path: '/other',
      });
      await upsertFileState(db, {
        job_id: jobId,
        local_path: 'mine.bin',
        size: 1,
        mtime_ms: 1,
        uploaded_at: 1,
      });
      await upsertFileState(db, {
        job_id: otherJobId,
        local_path: 'theirs.bin',
        size: 1,
        mtime_ms: 1,
        uploaded_at: 1,
      });

      const rows = await listSyncedFileStateForJob(db, jobId);
      expect(rows.map((r) => r.local_path)).toEqual(['mine.bin']);
    });
  });
});
