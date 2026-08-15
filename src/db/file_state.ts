import type { SqliteDb } from './adapter';
import type { FileStateRow } from './types';

export interface FileStateUpsert {
  job_id: number;
  local_path: string;
  size: number;
  mtime_ms: number;
  wark?: string | null;
  last_hashed_at?: number | null;
  uploaded_at?: number | null;
}

export async function getFileState(
  db: SqliteDb,
  jobId: number,
  localPath: string,
): Promise<FileStateRow | null> {
  return db.getFirstAsync<FileStateRow>(
    'SELECT * FROM file_state WHERE job_id = ? AND local_path = ?',
    [jobId, localPath],
  );
}

export async function listFileStateForJob(
  db: SqliteDb,
  jobId: number,
): Promise<FileStateRow[]> {
  return db.getAllAsync<FileStateRow>(
    'SELECT * FROM file_state WHERE job_id = ?',
    [jobId],
  );
}

/** Just the columns the engine's `isAlreadySynced` compares. */
export interface FileStateSyncKey {
  local_path: string;
  size: number;
  mtime_ms: number;
}

/**
 * The (size, mtime) skip index for one job's scan pass.
 *
 * A run loads this whole set up front, so on a 10k-file job `SELECT *` was
 * marshalling `wark` (44 chars/row) and `last_hashed_at` across the bridge for
 * nothing — neither is read anywhere.
 *
 * Filtering `uploaded_at IS NOT NULL` here is semantics-preserving: a
 * half-finished row used to be loaded and then rejected by the `uploaded_at`
 * check in `isAlreadySynced`, and is now simply absent, which the caller's Map
 * lookup treats identically.
 */
export async function listSyncedFileStateForJob(
  db: SqliteDb,
  jobId: number,
): Promise<FileStateSyncKey[]> {
  return db.getAllAsync<FileStateSyncKey>(
    `SELECT local_path, size, mtime_ms FROM file_state
      WHERE job_id = ? AND uploaded_at IS NOT NULL`,
    [jobId],
  );
}

export async function upsertFileState(
  db: SqliteDb,
  row: FileStateUpsert,
): Promise<void> {
  await db.runAsync(
    `INSERT INTO file_state (job_id, local_path, size, mtime_ms, wark, last_hashed_at, uploaded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(job_id, local_path) DO UPDATE SET
       size = excluded.size,
       mtime_ms = excluded.mtime_ms,
       wark = excluded.wark,
       last_hashed_at = excluded.last_hashed_at,
       uploaded_at = excluded.uploaded_at`,
    [
      row.job_id,
      row.local_path,
      row.size,
      row.mtime_ms,
      row.wark ?? null,
      row.last_hashed_at ?? null,
      row.uploaded_at ?? null,
    ],
  );
}

export async function deleteFileState(
  db: SqliteDb,
  jobId: number,
  localPath: string,
): Promise<void> {
  await db.runAsync(
    'DELETE FROM file_state WHERE job_id = ? AND local_path = ?',
    [jobId, localPath],
  );
}
