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
