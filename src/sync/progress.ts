import type { ErrorPhase, RunTrigger } from '../db/types';

export type RunPhase = 'scanning' | 'uploading' | 'finalizing';

export interface RunCountersSnapshot {
  scanned: number;
  uploaded: number;
  skipped: number;
  failed: number;
  bytesUploaded: number;
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
  counters: RunCountersSnapshot;
  activeFile: ActiveFileSnapshot | null;
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
  bytesUploaded: 0,
});

/**
 * Typed event bus for the currently-executing sync run. v1 has a single-slot
 * active-run model (no scheduler → at most one run at a time); screens
 * subscribe via `useSyncExternalStore(bus.subscribe, bus.getSnapshot)` and
 * re-render on every mutation.
 *
 * Snapshots are immutable — every mutator creates a fresh top-level object so
 * referential equality checks in React do the right thing.
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
        counters: emptyCounters(),
        activeFile: null,
        errors: [],
      },
    });
  }

  setPhase(phase: RunPhase): void {
    this.withActive((run) => ({ ...run, phase }));
  }

  setActiveFile(file: ActiveFileSnapshot | null): void {
    this.withActive((run) => ({ ...run, activeFile: file }));
  }

  updateActiveFileBytes(bytesUploaded: number): void {
    const run = this.snapshot.activeRun;
    if (!run?.activeFile) return;
    this.mutate({
      activeRun: { ...run, activeFile: { ...run.activeFile, bytesUploaded } },
    });
  }

  bumpCounters(delta: Partial<RunCountersSnapshot>): void {
    this.withActive((run) => ({
      ...run,
      counters: {
        scanned: run.counters.scanned + (delta.scanned ?? 0),
        uploaded: run.counters.uploaded + (delta.uploaded ?? 0),
        skipped: run.counters.skipped + (delta.skipped ?? 0),
        failed: run.counters.failed + (delta.failed ?? 0),
        bytesUploaded:
          run.counters.bytesUploaded + (delta.bytesUploaded ?? 0),
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
