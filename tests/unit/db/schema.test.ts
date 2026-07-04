import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CURRENT_SCHEMA_VERSION, runMigrations } from '@/src/db/schema';

import { createTestDb } from './adapter';

let db: ReturnType<typeof createTestDb>;

beforeEach(() => {
  db = createTestDb();
});
afterEach(() => {
  db.close();
});

describe('runMigrations', () => {
  it('creates all expected tables and indexes', async () => {
    await runMigrations(db);
    const tables = await db.getAllAsync<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      [],
    );
    const names = tables.map((t) => t.name);
    for (const required of [
      'schema_migrations',
      'servers',
      'jobs',
      'file_state',
      'runs',
      'run_errors',
    ]) {
      expect(names).toContain(required);
    }
  });

  it('records the current version in schema_migrations', async () => {
    await runMigrations(db);
    const rows = await db.getAllAsync<{ version: number }>(
      'SELECT version FROM schema_migrations',
      [],
    );
    expect(rows.map((r) => r.version)).toContain(CURRENT_SCHEMA_VERSION);
  });

  it('is idempotent (running twice does not error or re-apply)', async () => {
    await runMigrations(db);
    const first = await db.getAllAsync<{ version: number; applied_at: number }>(
      'SELECT version, applied_at FROM schema_migrations ORDER BY version',
      [],
    );
    await runMigrations(db);
    const second = await db.getAllAsync<{ version: number; applied_at: number }>(
      'SELECT version, applied_at FROM schema_migrations ORDER BY version',
      [],
    );
    expect(second).toEqual(first);
  });

  it('migration v2 adds periodic fields to jobs and skip_reason to runs', async () => {
    await runMigrations(db);
    const jobCols = await db.getAllAsync<{ name: string }>(
      "PRAGMA table_info('jobs')",
      [],
    );
    const jobNames = jobCols.map((c) => c.name);
    expect(jobNames).toContain('periodic_enabled');
    expect(jobNames).toContain('periodic_minutes');

    const runCols = await db.getAllAsync<{ name: string }>(
      "PRAGMA table_info('runs')",
      [],
    );
    expect(runCols.map((c) => c.name)).toContain('skip_reason');
  });

  it('migration v3 adds path_organization to jobs', async () => {
    await runMigrations(db);
    const jobCols = await db.getAllAsync<{ name: string }>(
      "PRAGMA table_info('jobs')",
      [],
    );
    expect(jobCols.map((c) => c.name)).toContain('path_organization');
  });

  it('migration v4 adds max_concurrency to jobs and bytes_deduped to runs', async () => {
    await runMigrations(db);
    const jobCols = await db.getAllAsync<{ name: string; dflt_value: unknown }>(
      "PRAGMA table_info('jobs')",
      [],
    );
    const concCol = jobCols.find((c) => c.name === 'max_concurrency');
    expect(concCol).toBeTruthy();
    expect(Number(concCol!.dflt_value)).toBe(3);

    const runCols = await db.getAllAsync<{ name: string; dflt_value: unknown }>(
      "PRAGMA table_info('runs')",
      [],
    );
    const dedupCol = runCols.find((c) => c.name === 'bytes_deduped');
    expect(dedupCol).toBeTruthy();
    expect(Number(dedupCol!.dflt_value)).toBe(0);
  });

  it('migration v5 adds the settings table and notify columns to jobs', async () => {
    await runMigrations(db);
    const tables = await db.getAllAsync<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table'",
      [],
    );
    expect(tables.map((t) => t.name)).toContain('settings');

    const jobCols = await db.getAllAsync<{ name: string; dflt_value: unknown }>(
      "PRAGMA table_info('jobs')",
      [],
    );
    const success = jobCols.find((c) => c.name === 'notify_on_success');
    const failure = jobCols.find((c) => c.name === 'notify_on_failure');
    expect(success).toBeTruthy();
    expect(failure).toBeTruthy();
    expect(Number(success!.dflt_value)).toBe(1);
    expect(Number(failure!.dflt_value)).toBe(1);
  });

  it('enables foreign key enforcement', async () => {
    await runMigrations(db);
    const row = await db.getFirstAsync<{ foreign_keys: number }>(
      'PRAGMA foreign_keys',
      [],
    );
    expect(row?.foreign_keys).toBe(1);
  });
});
