import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createJob, listJobs } from '@/src/db/jobs';
import { runMigrations } from '@/src/db/schema';
import { createServer } from '@/src/db/servers';
import type { SqliteDb } from '@/src/db/adapter';
import type { RunRow } from '@/src/db/types';
import {
  defaultSyncAllBus,
  requestCancelAll,
  runAllJobsManual,
} from '@/src/sync/triggers/sync-all';

import { createTestDb } from '../db/adapter';

let db: ReturnType<typeof createTestDb>;
let serverId: number;

beforeEach(async () => {
  db = createTestDb();
  await runMigrations(db);
  serverId = await createServer(db, { name: 's', base_url: 'http://localhost:9999' });
});
afterEach(() => db.close());

function addJob(name: string, sourceUri = 'content://fake/tree'): Promise<number> {
  return createJob(db, {
    server_id: serverId,
    name,
    source_kind: 'saf',
    source_uri: sourceUri,
    remote_path: '/target',
  });
}

const fakeRun = {} as RunRow;

describe('runAllJobsManual', () => {
  it('runs every runnable job sequentially in list order', async () => {
    await addJob('a');
    await addJob('b');
    await addJob('c');
    const expected = (await listJobs(db)).map((j) => j.id);

    const calls: number[] = [];
    let inFlight = 0;
    const runOne = vi.fn(async (_db: SqliteDb, jobId: number) => {
      inFlight += 1;
      expect(inFlight).toBe(1); // strictly sequential
      calls.push(jobId);
      await Promise.resolve();
      inFlight -= 1;
      return fakeRun;
    });

    const res = await runAllJobsManual(db, runOne);
    expect(calls).toEqual(expected);
    expect(res).toEqual({
      ran: 3,
      skippedNoSource: 0,
      failedToStart: [],
      cancelled: false,
    });
    expect(defaultSyncAllBus.getSnapshot().batch).toBeNull();
  });

  it('skips jobs with no source picked and reports the count', async () => {
    await addJob('ready');
    await addJob('unpicked', '');

    const runOne = vi.fn(async () => fakeRun);
    const res = await runAllJobsManual(db, runOne);
    expect(runOne).toHaveBeenCalledTimes(1);
    expect(res.ran).toBe(1);
    expect(res.skippedNoSource).toBe(1);
  });

  it('continues past a job that fails to start and reports it', async () => {
    await addJob('a');
    await addJob('b');
    const jobs = await listJobs(db);
    const failing = jobs[0];

    const runOne = vi.fn(async (_db: SqliteDb, jobId: number) => {
      if (jobId === failing.id) throw new Error('no password');
      return fakeRun;
    });

    const res = await runAllJobsManual(db, runOne);
    expect(runOne).toHaveBeenCalledTimes(2);
    expect(res.ran).toBe(1);
    expect(res.failedToStart).toEqual([
      { name: failing.name, message: 'no password' },
    ]);
  });

  it('stops the queue when requestCancelAll fires mid-batch', async () => {
    await addJob('a');
    await addJob('b');
    await addJob('c');

    const runOne = vi.fn(async () => {
      // Cancel during the first run: it finishes, the rest never start.
      requestCancelAll();
      return fakeRun;
    });

    const res = await runAllJobsManual(db, runOne);
    expect(runOne).toHaveBeenCalledTimes(1);
    expect(res.ran).toBe(1);
    expect(res.cancelled).toBe(true);
    expect(defaultSyncAllBus.getSnapshot().batch).toBeNull();
  });

  it('publishes batch progress while running and clears it after', async () => {
    await addJob('a');
    await addJob('b');

    const seen: { completed: number; total: number }[] = [];
    const runOne = vi.fn(async () => {
      const b = defaultSyncAllBus.getSnapshot().batch;
      expect(b).not.toBeNull();
      seen.push({ completed: b!.completed, total: b!.total });
      return fakeRun;
    });

    await runAllJobsManual(db, runOne);
    expect(seen).toEqual([
      { completed: 0, total: 2 },
      { completed: 1, total: 2 },
    ]);
    expect(defaultSyncAllBus.getSnapshot().batch).toBeNull();
  });

  it('refuses to start while another batch is active', async () => {
    await addJob('a');
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const first = runAllJobsManual(db, async () => {
      await gate;
      return fakeRun;
    });
    // Wait until the first batch has published its state before the second starts.
    await vi.waitFor(() =>
      expect(defaultSyncAllBus.getSnapshot().batch).not.toBeNull(),
    );
    await expect(runAllJobsManual(db, async () => fakeRun)).rejects.toThrow(
      'already running',
    );
    release();
    await first;
  });
});
