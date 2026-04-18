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

  it('enables foreign key enforcement', async () => {
    await runMigrations(db);
    const row = await db.getFirstAsync<{ foreign_keys: number }>(
      'PRAGMA foreign_keys',
      [],
    );
    expect(row?.foreign_keys).toBe(1);
  });
});
