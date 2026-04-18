export type SqlParam = string | number | null | Uint8Array;
export type SqlParams = SqlParam[];

/**
 * Subset of expo-sqlite's async SQLiteDatabase API that our DAOs use.
 *
 * Structural match: an `expo-sqlite` `SQLiteDatabase` satisfies this interface
 * as-is at runtime. The unit-test shim in `tests/unit/db/adapter.ts` wraps
 * `better-sqlite3` to expose the same shape, so DAO code runs unmodified in
 * both environments.
 */
export interface SqliteDb {
  execAsync(source: string): Promise<void>;
  runAsync(
    source: string,
    params: SqlParams,
  ): Promise<{ lastInsertRowId: number; changes: number }>;
  getFirstAsync<T>(source: string, params: SqlParams): Promise<T | null>;
  getAllAsync<T>(source: string, params: SqlParams): Promise<T[]>;
  withTransactionAsync(cb: () => Promise<void>): Promise<void>;
}
