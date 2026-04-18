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
