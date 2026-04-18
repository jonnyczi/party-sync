import Database from 'better-sqlite3';

import type { SqliteDb, SqlParams } from '@/src/db/adapter';

/**
 * better-sqlite3-backed SqliteDb for unit tests. Mirrors the async shape of
 * expo-sqlite by wrapping synchronous calls in Promise.resolve.
 */
export function createTestDb(): SqliteDb & { close: () => void } {
  const raw = new Database(':memory:');

  const db: SqliteDb & { close: () => void } = {
    async execAsync(source: string): Promise<void> {
      raw.exec(source);
    },
    async runAsync(
      source: string,
      params: SqlParams = [],
    ): Promise<{ lastInsertRowId: number; changes: number }> {
      const stmt = raw.prepare(source);
      const info = stmt.run(...params);
      return {
        lastInsertRowId: Number(info.lastInsertRowid),
        changes: info.changes,
      };
    },
    async getFirstAsync<T>(
      source: string,
      params: SqlParams = [],
    ): Promise<T | null> {
      const stmt = raw.prepare(source);
      const row = stmt.get(...params) as T | undefined;
      return row ?? null;
    },
    async getAllAsync<T>(
      source: string,
      params: SqlParams = [],
    ): Promise<T[]> {
      const stmt = raw.prepare(source);
      return stmt.all(...params) as T[];
    },
    async withTransactionAsync(cb: () => Promise<void>): Promise<void> {
      // better-sqlite3's transaction() expects a sync fn; we drive an async
      // callback manually with BEGIN/COMMIT/ROLLBACK to stay API-compatible.
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

  return db;
}
