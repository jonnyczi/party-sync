import type { ErrorPhase, RunTrigger } from '../db/types';

export type RunPhase = 'scanning' | 'uploading' | 'finalizing';

export interface RunCountersSnapshot {
  scanned: number;
  uploaded: number;
  skipped: number;
  failed: number;
}

export interface ActiveFileSnapshot {
  localPath: string;
  name: string;
  size: number;
  bytesUploaded: number;
}

export interface RunErrorSnapshot {
  localPath: string;
  phase: ErrorPhase;
  httpStatus?: number;
  message?: string;
}

export interface ActiveRunSnapshot {
  runId: number;
  jobId: number;
  trigger: RunTrigger;
  startedAt: number;
  phase: RunPhase;
  /** Exact file count from the pre-scan pass (0 until `setTotals`). */
  totalFiles: number;
  /** Exact byte total from the pre-scan pass (0 until `setTotals`). */
  totalBytes: number;
  /**
   * Overall progress-bar numerator: bytes "accounted for" so far — actually
   * uploaded over the wire (via `updateFileBytes`) plus deduped (`recordDedup`)
   * and skipped (`advanceUploaded`) bytes. Reaches `totalBytes` when every file
   * has been processed, so a re-run of an already-synced job still fills the bar.
   */
  uploadedBytes: number;
  /** Live tally of bytes the server already had (the "saved via dedup" stat). */
  dedupedBytes: number;
  counters: RunCountersSnapshot;
  /** Files currently in flight, keyed by `localPath`. */
  activeFiles: ActiveFileSnapshot[];
  errors: RunErrorSnapshot[];
}

export interface ProgressSnapshot {
  activeRun: ActiveRunSnapshot | null;
}

type Listener = () => void;

const emptyCounters = (): RunCountersSnapshot => ({
  scanned: 0,
  uploaded: 0,
  skipped: 0,
  failed: 0,
});

/**
 * Typed event bus for the currently-executing sync run. v1 has a single-slot
 * active-run model (no scheduler → at most one run at a time); screens
 * subscribe via `useSyncExternalStore(bus.subscribe, bus.getSnapshot)` and
 * re-render on every mutation.
 *
 * Snapshots are immutable — every mutator creates a fresh top-level object so
 * referential equality checks in React do the right thing. Under per-job
 * concurrency several files upload at once, so the active file is a list
 * (`activeFiles`) keyed by `localPath`.
 */
export class ProgressBus {
  private listeners = new Set<Listener>();
  private snapshot: ProgressSnapshot = { activeRun: null };

  subscribe = (cb: Listener): (() => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };

  getSnapshot = (): ProgressSnapshot => this.snapshot;

  startRun(input: {
    runId: number;
    jobId: number;
    trigger: RunTrigger;
    startedAt: number;
  }): void {
    this.mutate({
      activeRun: {
        runId: input.runId,
        jobId: input.jobId,
        trigger: input.trigger,
        startedAt: input.startedAt,
        phase: 'scanning',
        totalFiles: 0,
        totalBytes: 0,
        uploadedBytes: 0,
        dedupedBytes: 0,
        counters: emptyCounters(),
        activeFiles: [],
        errors: [],
      },
    });
  }

  setPhase(phase: RunPhase): void {
    this.withActive((run) => ({ ...run, phase }));
  }

  /** Record the exact totals from the pre-scan pass. */
  setTotals(input: { totalFiles: number; totalBytes: number }): void {
    this.withActive((run) => ({
      ...run,
      totalFiles: input.totalFiles,
      totalBytes: input.totalBytes,
    }));
  }

  /** Add a file to the in-flight set (replacing any prior entry for its path). */
  startFile(file: ActiveFileSnapshot): void {
    this.withActive((run) => ({
      ...run,
      activeFiles: [
        ...run.activeFiles.filter((f) => f.localPath !== file.localPath),
        file,
      ],
    }));
  }

  /**
   * Update an in-flight file's uploaded byte count. The positive delta versus
   * its previous value advances the run-level `uploadedBytes`. No-op if the
   * file is no longer in flight (a late progress callback after `endFile`).
   */
  updateFileBytes(localPath: string, bytesUploaded: number): void {
    const run = this.snapshot.activeRun;
    if (!run) return;
    const file = run.activeFiles.find((f) => f.localPath === localPath);
    if (!file) return;
    const delta = bytesUploaded - file.bytesUploaded;
    this.mutate({
      activeRun: {
        ...run,
        uploadedBytes: run.uploadedBytes + delta,
        activeFiles: run.activeFiles.map((f) =>
          f.localPath === localPath ? { ...f, bytesUploaded } : f,
        ),
      },
    });
  }

  /** Remove a file from the in-flight set. Leaves `uploadedBytes` unchanged. */
  endFile(localPath: string): void {
    this.withActive((run) => ({
      ...run,
      activeFiles: run.activeFiles.filter((f) => f.localPath !== localPath),
    }));
  }

  /**
   * Advance the overall `uploadedBytes` by bytes that never crossed the wire
   * as chunk POSTs but are nonetheless "done" — the full size of a skipped
   * (size+mtime match) file — so the progress bar still completes.
   */
  advanceUploaded(delta: number): void {
    if (delta <= 0) return;
    this.withActive((run) => ({
      ...run,
      uploadedBytes: run.uploadedBytes + delta,
    }));
  }

  /**
   * Record bytes the server already had (dedup): advances the overall bar AND
   * the live `dedupedBytes` tally shown as "saved via dedup".
   */
  recordDedup(delta: number): void {
    if (delta <= 0) return;
    this.withActive((run) => ({
      ...run,
      uploadedBytes: run.uploadedBytes + delta,
      dedupedBytes: run.dedupedBytes + delta,
    }));
  }

  bumpCounters(delta: Partial<RunCountersSnapshot>): void {
    this.withActive((run) => ({
      ...run,
      counters: {
        scanned: run.counters.scanned + (delta.scanned ?? 0),
        uploaded: run.counters.uploaded + (delta.uploaded ?? 0),
        skipped: run.counters.skipped + (delta.skipped ?? 0),
        failed: run.counters.failed + (delta.failed ?? 0),
      },
    }));
  }

  recordError(err: RunErrorSnapshot): void {
    this.withActive((run) => ({ ...run, errors: [...run.errors, err] }));
  }

  finishRun(): void {
    this.mutate({ activeRun: null });
  }

  private withActive(update: (run: ActiveRunSnapshot) => ActiveRunSnapshot): void {
    const current = this.snapshot.activeRun;
    if (!current) return;
    this.mutate({ activeRun: update(current) });
  }

  private mutate(next: ProgressSnapshot): void {
    this.snapshot = next;
    for (const l of this.listeners) l();
  }
}

export const defaultProgressBus = new ProgressBus();
