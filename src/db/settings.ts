import type { SqliteDb } from './adapter';

/**
 * Tiny key-value settings store for app-wide (not per-job, not per-server)
 * preferences. Booleans are stored as the text `'1'`/`'0'`. Keys are namespaced
 * by feature; add a typed accessor pair per setting so callers never touch raw
 * keys/strings.
 */

/** Master kill-switch for sync result notifications (Settings tab). Default on. */
export const RESULT_NOTIFICATIONS_KEY = 'result_notifications_enabled';

/** How much of the link uploads may use while the screen is on. Default off. */
export const BANDWIDTH_MODE_KEY = 'bandwidth_mode';

/**
 * Share of the available link uploads should aim for while the phone is in
 * use. Not an absolute cap — the pacer measures its own throughput per chunk
 * and idles proportionally, so it adapts to whatever the connection is giving
 * (see src/sync/throttle.ts).
 */
export type BandwidthMode = 'full' | 'balanced' | 'gentle';

export const BANDWIDTH_SHARES: Record<BandwidthMode, number> = {
  full: 1,
  balanced: 0.5,
  gentle: 0.25,
};

const BANDWIDTH_MODES = Object.keys(BANDWIDTH_SHARES) as BandwidthMode[];

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

export async function getStringSetting(
  db: SqliteDb,
  key: string,
): Promise<string | null> {
  const row = await db.getFirstAsync<{ value: string }>(
    'SELECT value FROM settings WHERE key = ?',
    [key],
  );
  return row ? row.value : null;
}

export async function setStringSetting(
  db: SqliteDb,
  key: string,
  value: string,
): Promise<void> {
  await db.runAsync(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, value],
  );
}

/** Narrow an arbitrary string to a BandwidthMode, falling back to 'full'. */
export function parseBandwidthMode(v: unknown): BandwidthMode {
  return typeof v === 'string' && (BANDWIDTH_MODES as string[]).includes(v)
    ? (v as BandwidthMode)
    : 'full';
}

/**
 * Upload bandwidth share (default 'full' — no limit). An unrecognised stored
 * value degrades to 'full' rather than throwing, so a bad import or a
 * downgrade can never wedge syncing.
 */
export async function getBandwidthMode(db: SqliteDb): Promise<BandwidthMode> {
  return parseBandwidthMode(await getStringSetting(db, BANDWIDTH_MODE_KEY));
}

export async function setBandwidthMode(
  db: SqliteDb,
  mode: BandwidthMode,
): Promise<void> {
  await setStringSetting(db, BANDWIDTH_MODE_KEY, mode);
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
