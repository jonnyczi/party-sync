import type { SqliteDb } from '../../db/adapter';
import { listJobs } from '../../db/jobs';
import type { RunRow } from '../../db/types';
import { defaultProgressBus } from '../progress';
import { requestCancel } from '../run-control';

/**
 * Sequential "Sync all" batch over every runnable job.
 *
 * The progress bus is single-slot and `runJobManual` resolves when its run
 * finishes, so a plain awaited loop gives strictly-sequential runs with no
 * engine changes. This module only adds what the loop needs: batch-level
 * state for the UI (job k of n) and batch-level cancellation.
 */

export interface SyncAllBatchSnapshot {
  total: number;
  /** Jobs whose runs have finished (any outcome). */
  completed: number;
  currentJobId: number | null;
  currentJobName: string | null;
}

export interface SyncAllSnapshot {
  batch: SyncAllBatchSnapshot | null;
}

export interface SyncAllResult {
  /** Jobs whose runs were started (and finished, in any status). */
  ran: number;
  /** Jobs skipped because no source folder is picked yet. */
  skippedNoSource: number;
  /** Jobs whose run could not start (missing password, revoked permission…). */
  failedToStart: { name: string; message: string }[];
  cancelled: boolean;
}

type Listener = () => void;

class SyncAllBus {
  private listeners = new Set<Listener>();
  private snapshot: SyncAllSnapshot = { batch: null };

  subscribe = (cb: Listener): (() => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };

  getSnapshot = (): SyncAllSnapshot => this.snapshot;

  set(batch: SyncAllBatchSnapshot | null): void {
    this.snapshot = { batch };
    for (const l of this.listeners) l();
  }
}

export const defaultSyncAllBus = new SyncAllBus();

let cancelRequested = false;

/**
 * Stop the whole batch: no further jobs start, and the in-flight run (if
 * any) is aborted through the regular per-run cancel path, so it finalizes
 * as `cancelled` exactly like a single-run cancel.
 */
export function requestCancelAll(): void {
  if (!defaultSyncAllBus.getSnapshot().batch) return;
  cancelRequested = true;
  const active = defaultProgressBus.getSnapshot().activeRun;
  if (active) requestCancel(active.runId);
}

/**
 * Run every job once, sequentially, in `listJobs` order. User-initiated —
 * per-job network constraints (Wi-Fi only, charging only) are ignored, same
 * as tapping Sync now on each job. Jobs with no source folder picked are
 * skipped. A job whose run fails to *start* is reported in `failedToStart`
 * and the batch moves on; a run that starts and fails records its own run
 * row like any other.
 *
 * `runOne` is injectable for tests. The default (`runJobManual`) is loaded
 * lazily — its import chain reaches native Expo modules that must not load
 * in the node test environment.
 */
export async function runAllJobsManual(
  db: SqliteDb,
  runOne?: (db: SqliteDb, jobId: number) => Promise<RunRow>,
): Promise<SyncAllResult> {
  if (defaultSyncAllBus.getSnapshot().batch || defaultProgressBus.getSnapshot().activeRun) {
    throw new Error('A sync is already running.');
  }

  const jobs = await listJobs(db);
  const runnable = jobs.filter(
    (j) => !(j.source_kind === 'saf' && j.source_uri === ''),
  );
  const result: SyncAllResult = {
    ran: 0,
    skippedNoSource: jobs.length - runnable.length,
    failedToStart: [],
    cancelled: false,
  };
  if (runnable.length === 0) return result;

  const run = runOne ?? (await import('./manual')).runJobManual;
  cancelRequested = false;
  defaultSyncAllBus.set({
    total: runnable.length,
    completed: 0,
    currentJobId: null,
    currentJobName: null,
  });
  try {
    for (const job of runnable) {
      if (cancelRequested) {
        result.cancelled = true;
        break;
      }
      defaultSyncAllBus.set({
        total: runnable.length,
        completed: result.ran,
        currentJobId: job.id,
        currentJobName: job.name,
      });
      try {
        await run(db, job.id);
        result.ran += 1;
      } catch (e) {
        result.failedToStart.push({
          name: job.name,
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }
    if (cancelRequested) result.cancelled = true;
    return result;
  } finally {
    cancelRequested = false;
    defaultSyncAllBus.set(null);
  }
}
