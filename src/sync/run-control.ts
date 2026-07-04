/**
 * Out-of-band cancellation registry for in-progress runs.
 *
 * `runJob` (and the trigger wrappers around it) don't return until the run
 * finishes, so the UI can't pass a cancel flag *into* a run that's already
 * underway. Instead the UI calls `requestCancel(runId)` here, and the engine
 * polls `isCancelRequested(runId)` between files. The engine `clear`s the entry
 * in a `finally` so the set never leaks across runs.
 *
 * Cancellation is cooperative and between-files: scheduling of new files stops,
 * but any in-flight upload is allowed to settle (no AbortSignal in v1).
 */
const cancelled = new Set<number>();

export function requestCancel(runId: number): void {
  cancelled.add(runId);
}

export function isCancelRequested(runId: number): boolean {
  return cancelled.has(runId);
}

export function clear(runId: number): void {
  cancelled.delete(runId);
}
