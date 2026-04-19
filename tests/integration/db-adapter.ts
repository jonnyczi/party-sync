import Database from 'better-sqlite3';

import type { SqliteDb, SqlParams } from '../../src/db/adapter';

/**
 * Same better-sqlite3-backed shim as `tests/unit/db/adapter.ts`, duplicated
 * here so integration tests don't reach across the unit-tests tree. The
 * unit version lives with its (many) DAO tests; the integration version
 * only has to serve the engine test.
 */
export function createNodeSqliteDb(): SqliteDb & { close: () => void } {
  const raw = new Database(':memory:');
  return {
    async execAsync(source: string): Promise<void> {
      raw.exec(source);
    },
    async runAsync(source: string, params: SqlParams = []) {
      const info = raw.prepare(source).run(...params);
      return { lastInsertRowId: Number(info.lastInsertRowid), changes: info.changes };
    },
    async getFirstAsync<T>(source: string, params: SqlParams = []): Promise<T | null> {
      return (raw.prepare(source).get(...params) as T | undefined) ?? null;
    },
    async getAllAsync<T>(source: string, params: SqlParams = []): Promise<T[]> {
      return raw.prepare(source).all(...params) as T[];
    },
    async withTransactionAsync(cb: () => Promise<void>): Promise<void> {
      raw.exec('BEGIN');
      try {
        await cb();
        raw.exec('COMMIT');
      } catch (e) {
        raw.exec('ROLLBACK');
        throw e;
      }
    },
    close: () => raw.close(),
  };
}
