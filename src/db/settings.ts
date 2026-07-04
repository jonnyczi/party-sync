import type { SqliteDb } from './adapter';

/**
 * Tiny key-value settings store for app-wide (not per-job, not per-server)
 * preferences. Booleans are stored as the text `'1'`/`'0'`. Keys are namespaced
 * by feature; add a typed accessor pair per setting so callers never touch raw
 * keys/strings.
 */

/** Master kill-switch for sync result notifications (Settings tab). Default on. */
export const RESULT_NOTIFICATIONS_KEY = 'result_notifications_enabled';

export async function getBoolSetting(
  db: SqliteDb,
  key: string,
  fallback: boolean,
): Promise<boolean> {
  const row = await db.getFirstAsync<{ value: string }>(
    'SELECT value FROM settings WHERE key = ?',
    [key],
  );
  if (!row) return fallback;
  return row.value === '1';
}

export async function setBoolSetting(
  db: SqliteDb,
  key: string,
  value: boolean,
): Promise<void> {
  await db.runAsync(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, value ? '1' : '0'],
  );
}

/** Whether sync completion/failure notifications are globally enabled (default true). */
export async function getResultNotificationsEnabled(db: SqliteDb): Promise<boolean> {
  return getBoolSetting(db, RESULT_NOTIFICATIONS_KEY, true);
}

export async function setResultNotificationsEnabled(
  db: SqliteDb,
  enabled: boolean,
): Promise<void> {
  await setBoolSetting(db, RESULT_NOTIFICATIONS_KEY, enabled);
}
