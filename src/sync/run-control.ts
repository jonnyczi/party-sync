/**
 * Out-of-band cancellation registry for in-progress runs, backed by one
 * `AbortController` per run.
 *
 * `runJob` (and the trigger wrappers around it) don't return until the run
 * finishes, so the UI can't pass a cancel flag *into* a run that's already
 * underway. Instead the engine `register`s a controller at run start, and the
 * UI calls `requestCancel(runId)` here, which aborts that controller's signal.
 *
 * The engine threads the signal into every `fetch`, so a cancel tears down the
 * in-flight upload immediately (not just between files) and also unblocks a
 * request that would otherwise hang forever. It still polls `isCancelRequested`
 * between files as a cheap early-out. The engine `clear`s the entry in a
 * `finally` so the map never leaks across runs.
 */
const controllers = new Map<number, AbortController>();

/**
 * Register a fresh `AbortController` for a run and return its signal. Called by
 * the engine at run start, before the run id is published to the UI, so a
 * cancel can never race ahead of the controller existing.
 */
export function register(runId: number): AbortSignal {
  const controller = new AbortController();
  controllers.set(runId, controller);
  return controller.signal;
}

/** Abort the run's signal. No-op if the run isn't registered (already gone). */
export function requestCancel(runId: number): void {
  controllers.get(runId)?.abort();
}

export function isCancelRequested(runId: number): boolean {
  return controllers.get(runId)?.signal.aborted ?? false;
}

/** The run's abort signal, if registered (for threading into fetch). */
export function signalFor(runId: number): AbortSignal | undefined {
  return controllers.get(runId)?.signal;
}

export function clear(runId: number): void {
  controllers.delete(runId);
}
