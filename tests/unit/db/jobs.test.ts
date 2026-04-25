import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createJob,
  deleteJob,
  getJob,
  listJobsForServer,
  updateJob,
} from '@/src/db/jobs';
import { runMigrations } from '@/src/db/schema';
import { createServer } from '@/src/db/servers';

import { createTestDb } from './adapter';

let db: ReturnType<typeof createTestDb>;
let serverId: number;

beforeEach(async () => {
  db = createTestDb();
  await runMigrations(db);
  serverId = await createServer(db, { name: 's', base_url: 'https://s' });
});
afterEach(() => {
  db.close();
});

describe('jobs DAO', () => {
  it('creates with defaults', async () => {
    const id = await createJob(db, {
      server_id: serverId,
      name: 'camera',
      source_kind: 'media',
      source_uri: 'bucket:camera',
      remote_path: '/phone/camera',
    });
    const row = await getJob(db, id);
    expect(row?.propagate_deletes).toBe(0);
    expect(row?.wifi_only).toBe(1);
    expect(row?.respect_data_saver).toBe(1);
    expect(row?.charging_only).toBe(0);
    expect(row?.rehash_interval_days).toBe(30);
    expect(row?.periodic_enabled).toBe(0);
    expect(row?.periodic_minutes).toBe(60);
  });

  it('round-trips periodic fields', async () => {
    const id = await createJob(db, {
      server_id: serverId,
      name: 'sched',
      source_kind: 'saf',
      source_uri: 'content://tree',
      remote_path: '/r',
      periodic_enabled: true,
      periodic_minutes: 30,
    });
    let row = await getJob(db, id);
    expect(row?.periodic_enabled).toBe(1);
    expect(row?.periodic_minutes).toBe(30);

    await updateJob(db, id, {
      server_id: serverId,
      name: 'sched',
      source_kind: 'saf',
      source_uri: 'content://tree',
      remote_path: '/r',
      periodic_enabled: false,
      periodic_minutes: 15,
    });
    row = await getJob(db, id);
    expect(row?.periodic_enabled).toBe(0);
    expect(row?.periodic_minutes).toBe(15);
  });

  it('honors boolean overrides in create/update', async () => {
    const id = await createJob(db, {
      server_id: serverId,
      name: 'saf',
      source_kind: 'saf',
      source_uri: 'content://tree',
      remote_path: '/r',
      propagate_deletes: true,
      wifi_only: false,
      charging_only: true,
      rehash_interval_days: 7,
    });
    let row = await getJob(db, id);
    expect(row?.propagate_deletes).toBe(1);
    expect(row?.wifi_only).toBe(0);
    expect(row?.charging_only).toBe(1);
    expect(row?.rehash_interval_days).toBe(7);

    await updateJob(db, id, {
      server_id: serverId,
      name: 'saf2',
      source_kind: 'saf',
      source_uri: 'content://tree',
      remote_path: '/r2',
      propagate_deletes: false,
    });
    row = await getJob(db, id);
    expect(row?.name).toBe('saf2');
    expect(row?.remote_path).toBe('/r2');
    expect(row?.propagate_deletes).toBe(0);
    expect(row?.wifi_only).toBe(1);
  });

  it('rejects invalid source_kind via CHECK', async () => {
    await expect(
      db.runAsync(
        `INSERT INTO jobs (server_id, name, source_kind, source_uri, remote_path, created_at, updated_at)
         VALUES (?, 'bad', 'ftp', 'x', '/y', ?, ?)`,
        [serverId, Date.now(), Date.now()],
      ),
    ).rejects.toThrow();
  });

  it('listJobsForServer filters by server', async () => {
    const otherServer = await createServer(db, {
      name: 's2',
      base_url: 'https://s2',
    });
    await createJob(db, {
      server_id: serverId,
      name: 'a',
      source_kind: 'saf',
      source_uri: 'x',
      remote_path: '/a',
    });
    await createJob(db, {
      server_id: otherServer,
      name: 'b',
      source_kind: 'saf',
      source_uri: 'x',
      remote_path: '/b',
    });
    const mine = await listJobsForServer(db, serverId);
    expect(mine).toHaveLength(1);
    expect(mine[0].name).toBe('a');
  });

  it('deleteJob removes the row', async () => {
    const id = await createJob(db, {
      server_id: serverId,
      name: 'x',
      source_kind: 'saf',
      source_uri: 'x',
      remote_path: '/x',
    });
    await deleteJob(db, id);
    expect(await getJob(db, id)).toBeNull();
  });
});
