import type { SqliteDb } from './adapter';
import type {
  ErrorPhase,
  RunErrorRow,
  RunRow,
  RunStatus,
  RunTrigger,
} from './types';

export interface StartRunInput {
  job_id: number;
  trigger: RunTrigger;
}

export interface RunCounters {
  files_scanned?: number;
  files_uploaded?: number;
  files_skipped?: number;
  files_failed?: number;
  bytes_uploaded?: number;
}

export interface FinishRunInput extends RunCounters {
  status: RunStatus;
}

export async function startRun(
  db: SqliteDb,
  input: StartRunInput,
): Promise<number> {
  const res = await db.runAsync(
    `INSERT INTO runs (job_id, started_at, trigger, status)
     VALUES (?, ?, ?, 'running')`,
    [input.job_id, Date.now(), input.trigger],
  );
  return res.lastInsertRowId;
}

export async function updateRunCounters(
  db: SqliteDb,
  runId: number,
  counters: RunCounters,
): Promise<void> {
  await db.runAsync(
    `UPDATE runs SET
       files_scanned = COALESCE(?, files_scanned),
       files_uploaded = COALESCE(?, files_uploaded),
       files_skipped = COALESCE(?, files_skipped),
       files_failed = COALESCE(?, files_failed),
       bytes_uploaded = COALESCE(?, bytes_uploaded)
     WHERE id = ?`,
    [
      counters.files_scanned ?? null,
      counters.files_uploaded ?? null,
      counters.files_skipped ?? null,
      counters.files_failed ?? null,
      counters.bytes_uploaded ?? null,
      runId,
    ],
  );
}

export async function finishRun(
  db: SqliteDb,
  runId: number,
  input: FinishRunInput,
): Promise<void> {
  await db.runAsync(
    `UPDATE runs SET
       finished_at = ?,
       status = ?,
       files_scanned = COALESCE(?, files_scanned),
       files_uploaded = COALESCE(?, files_uploaded),
       files_skipped = COALESCE(?, files_skipped),
       files_failed = COALESCE(?, files_failed),
       bytes_uploaded = COALESCE(?, bytes_uploaded)
     WHERE id = ?`,
    [
      Date.now(),
      input.status,
      input.files_scanned ?? null,
      input.files_uploaded ?? null,
      input.files_skipped ?? null,
      input.files_failed ?? null,
      input.bytes_uploaded ?? null,
      runId,
    ],
  );
}

export async function getRun(
  db: SqliteDb,
  id: number,
): Promise<RunRow | null> {
  return db.getFirstAsync<RunRow>('SELECT * FROM runs WHERE id = ?', [id]);
}

export async function listRunsForJob(
  db: SqliteDb,
  jobId: number,
  limit = 20,
): Promise<RunRow[]> {
  return db.getAllAsync<RunRow>(
    'SELECT * FROM runs WHERE job_id = ? ORDER BY started_at DESC LIMIT ?',
    [jobId, limit],
  );
}

export async function getLatestRunForJob(
  db: SqliteDb,
  jobId: number,
): Promise<RunRow | null> {
  return db.getFirstAsync<RunRow>(
    'SELECT * FROM runs WHERE job_id = ? ORDER BY started_at DESC LIMIT 1',
    [jobId],
  );
}

export interface RunErrorInput {
  run_id: number;
  local_path: string;
  phase: ErrorPhase;
  http_status?: number | null;
  message?: string | null;
}

export async function recordRunError(
  db: SqliteDb,
  input: RunErrorInput,
): Promise<number> {
  const res = await db.runAsync(
    `INSERT INTO run_errors (run_id, local_path, phase, http_status, message)
     VALUES (?, ?, ?, ?, ?)`,
    [
      input.run_id,
      input.local_path,
      input.phase,
      input.http_status ?? null,
      input.message ?? null,
    ],
  );
  return res.lastInsertRowId;
}

export async function listRunErrors(
  db: SqliteDb,
  runId: number,
): Promise<RunErrorRow[]> {
  return db.getAllAsync<RunErrorRow>(
    'SELECT * FROM run_errors WHERE run_id = ? ORDER BY id ASC',
    [runId],
  );
}

export async function countRunErrors(
  db: SqliteDb,
  runId: number,
): Promise<number> {
  const row = await db.getFirstAsync<{ n: number }>(
    'SELECT COUNT(*) AS n FROM run_errors WHERE run_id = ?',
    [runId],
  );
  return row?.n ?? 0;
}

export async function listRunsSince(
  db: SqliteDb,
  sinceMs: number,
  limit = 500,
): Promise<RunRow[]> {
  return db.getAllAsync<RunRow>(
    'SELECT * FROM runs WHERE started_at >= ? ORDER BY started_at DESC LIMIT ?',
    [sinceMs, limit],
  );
}

export interface RecentErrorRow {
  error_id: number;
  run_id: number;
  job_id: number;
  job_name: string;
  local_path: string;
  phase: ErrorPhase;
  http_status: number | null;
  message: string | null;
  run_started_at: number;
  run_status: RunStatus;
}

export async function listRecentErrors(
  db: SqliteDb,
  limit = 50,
): Promise<RecentErrorRow[]> {
  return db.getAllAsync<RecentErrorRow>(
    `SELECT
       e.id          AS error_id,
       e.run_id      AS run_id,
       r.job_id      AS job_id,
       j.name        AS job_name,
       e.local_path  AS local_path,
       e.phase       AS phase,
       e.http_status AS http_status,
       e.message     AS message,
       r.started_at  AS run_started_at,
       r.status      AS run_status
     FROM run_errors e
     JOIN runs r ON r.id = e.run_id
     JOIN jobs j ON j.id = r.job_id
     ORDER BY r.started_at DESC, e.id DESC
     LIMIT ?`,
    [limit],
  );
}
