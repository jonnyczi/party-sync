import type { SqliteDb } from './adapter';
import type { JobRow, PathOrganization, SourceKind } from './types';

/** Per-job upload concurrency bounds. Default lives in the schema (3). */
export const MIN_CONCURRENCY = 1;
export const MAX_CONCURRENCY = 8;
export const DEFAULT_CONCURRENCY = 3;

export interface JobInput {
  server_id: number;
  name: string;
  source_kind: SourceKind;
  source_uri: string;
  remote_path: string;
  path_organization?: PathOrganization;
  propagate_deletes?: boolean;
  wifi_only?: boolean;
  respect_data_saver?: boolean;
  charging_only?: boolean;
  rehash_interval_days?: number;
  periodic_enabled?: boolean;
  periodic_minutes?: number;
  max_concurrency?: number;
  notify_on_success?: boolean;
  notify_on_failure?: boolean;
}

function bool(v: boolean | undefined, fallback: number): number {
  return v === undefined ? fallback : v ? 1 : 0;
}

/** Clamp a concurrency value to [MIN, MAX], falling back to the default. */
export function clampConcurrency(v: number | undefined): number {
  if (v === undefined || !Number.isFinite(v)) return DEFAULT_CONCURRENCY;
  return Math.max(MIN_CONCURRENCY, Math.min(MAX_CONCURRENCY, Math.round(v)));
}

export async function listJobs(db: SqliteDb): Promise<JobRow[]> {
  return db.getAllAsync<JobRow>(
    'SELECT * FROM jobs ORDER BY updated_at DESC, id DESC',
    [],
  );
}

export async function listJobsForServer(
  db: SqliteDb,
  serverId: number,
): Promise<JobRow[]> {
  return db.getAllAsync<JobRow>(
    'SELECT * FROM jobs WHERE server_id = ? ORDER BY updated_at DESC, id DESC',
    [serverId],
  );
}

export async function getJob(
  db: SqliteDb,
  id: number,
): Promise<JobRow | null> {
  return db.getFirstAsync<JobRow>('SELECT * FROM jobs WHERE id = ?', [id]);
}

export async function createJob(
  db: SqliteDb,
  input: JobInput,
): Promise<number> {
  const now = Date.now();
  const res = await db.runAsync(
    `INSERT INTO jobs (
       server_id, name, source_kind, source_uri, remote_path, path_organization,
       propagate_deletes, wifi_only, respect_data_saver, charging_only,
       rehash_interval_days, periodic_enabled, periodic_minutes, max_concurrency,
       notify_on_success, notify_on_failure,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.server_id,
      input.name,
      input.source_kind,
      input.source_uri,
      input.remote_path,
      input.path_organization ?? 'flat',
      bool(input.propagate_deletes, 0),
      bool(input.wifi_only, 1),
      bool(input.respect_data_saver, 1),
      bool(input.charging_only, 0),
      input.rehash_interval_days ?? 30,
      bool(input.periodic_enabled, 0),
      input.periodic_minutes ?? 60,
      clampConcurrency(input.max_concurrency),
      bool(input.notify_on_success, 1),
      bool(input.notify_on_failure, 1),
      now,
      now,
    ],
  );
  return res.lastInsertRowId;
}

export async function updateJob(
  db: SqliteDb,
  id: number,
  input: JobInput,
): Promise<void> {
  await db.runAsync(
    `UPDATE jobs SET
       server_id = ?, name = ?, source_kind = ?, source_uri = ?, remote_path = ?,
       path_organization = ?,
       propagate_deletes = ?, wifi_only = ?, respect_data_saver = ?, charging_only = ?,
       rehash_interval_days = ?, periodic_enabled = ?, periodic_minutes = ?,
       max_concurrency = ?, notify_on_success = ?, notify_on_failure = ?,
       updated_at = ?
     WHERE id = ?`,
    [
      input.server_id,
      input.name,
      input.source_kind,
      input.source_uri,
      input.remote_path,
      input.path_organization ?? 'flat',
      bool(input.propagate_deletes, 0),
      bool(input.wifi_only, 1),
      bool(input.respect_data_saver, 1),
      bool(input.charging_only, 0),
      input.rehash_interval_days ?? 30,
      bool(input.periodic_enabled, 0),
      input.periodic_minutes ?? 60,
      clampConcurrency(input.max_concurrency),
      bool(input.notify_on_success, 1),
      bool(input.notify_on_failure, 1),
      Date.now(),
      id,
    ],
  );
}

export async function deleteJob(db: SqliteDb, id: number): Promise<void> {
  await db.runAsync('DELETE FROM jobs WHERE id = ?', [id]);
}
