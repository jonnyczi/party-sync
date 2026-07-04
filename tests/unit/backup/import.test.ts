import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { importBundle, type ImportDeps } from '@/src/backup/import';
import type { BackupBundleV1 } from '@/src/backup/schema';
import { buildBundle } from '@/src/backup/serialize';
import { createServer, listServers } from '@/src/db/servers';
import { listJobs } from '@/src/db/jobs';
import { runMigrations } from '@/src/db/schema';
import type { JobRow, ServerRow } from '@/src/db/types';

import { createTestDb } from '../db/adapter';

let db: ReturnType<typeof createTestDb>;
let savedPasswords: Map<number, string>;
let deps: ImportDeps;

beforeEach(async () => {
  db = createTestDb();
  await runMigrations(db);
  savedPasswords = new Map();
  deps = {
    setPassword: async (id, pw) => {
      savedPasswords.set(id, pw);
    },
  };
});
afterEach(() => db.close());

function bundle(): BackupBundleV1 {
  const servers: ServerRow[] = [
    {
      id: 10,
      name: 'home',
      base_url: 'https://home:3923',
      username: 'jonny',
      cert_sha256: null,
      created_at: 1,
      updated_at: 1,
    },
  ];
  const jobs: JobRow[] = [
    {
      id: 100,
      server_id: 10,
      name: 'folder backup',
      source_kind: 'saf',
      source_uri: 'content://device/tree',
      remote_path: '/backups/folder',
      path_organization: 'flat',
      propagate_deletes: 0,
      wifi_only: 1,
      respect_data_saver: 1,
      charging_only: 0,
      rehash_interval_days: 30,
      periodic_enabled: 0,
      periodic_minutes: 60,
      max_concurrency: 3,
      created_at: 1,
      updated_at: 1,
    },
    {
      id: 101,
      server_id: 10,
      name: 'camera roll',
      source_kind: 'media',
      source_uri: 'all',
      remote_path: '/backups/camera',
      path_organization: 'year',
      propagate_deletes: 0,
      wifi_only: 1,
      respect_data_saver: 1,
      charging_only: 0,
      rehash_interval_days: 30,
      periodic_enabled: 0,
      periodic_minutes: 60,
      max_concurrency: 3,
      created_at: 1,
      updated_at: 1,
    },
  ];
  return buildBundle({
    servers,
    jobs,
    passwords: new Map([[10, 'hunter2']]),
    includePasswords: true,
    appVersion: '1.0.0',
  });
}

describe('importBundle', () => {
  it('imports servers + jobs into an empty database', async () => {
    const summary = await importBundle(db, bundle(), deps);
    expect(summary).toEqual({
      serversAdded: 1,
      serversSkipped: 0,
      jobsAdded: 2,
      jobsSkipped: 0,
      jobsNeedingSource: 1,
    });

    const servers = await listServers(db);
    expect(servers).toHaveLength(1);
    expect(servers[0].base_url).toBe('https://home:3923');
    expect(savedPasswords.get(servers[0].id)).toBe('hunter2');

    const jobs = await listJobs(db);
    const saf = jobs.find((j) => j.source_kind === 'saf')!;
    const media = jobs.find((j) => j.source_kind === 'media')!;
    expect(saf.source_uri).toBe(''); // must be re-picked on this device
    expect(media.source_uri).toBe('all'); // portable sentinel preserved
    expect(jobs.every((j) => j.server_id === servers[0].id)).toBe(true);
  });

  it('skips a server that already exists (matched by url + username)', async () => {
    await createServer(db, {
      name: 'pre-existing',
      base_url: 'https://home:3923',
      username: 'jonny',
    });
    const summary = await importBundle(db, bundle(), deps);
    expect(summary.serversAdded).toBe(0);
    expect(summary.serversSkipped).toBe(1);
    // jobs still link to the existing server
    expect(summary.jobsAdded).toBe(2);
    expect((await listServers(db))).toHaveLength(1);
  });

  it('skips a duplicate job on a second import (idempotent merge)', async () => {
    await importBundle(db, bundle(), deps);
    const second = await importBundle(db, bundle(), deps);
    expect(second.serversSkipped).toBe(1);
    expect(second.jobsSkipped).toBe(2);
    expect(second.jobsAdded).toBe(0);
    expect(await listJobs(db)).toHaveLength(2);
  });
});
