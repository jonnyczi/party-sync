import { CopypartyClient, RequestCancelledError } from '../copyparty/client';
import type { FileSource } from '../copyparty/hash';
import { Up2kError } from '../copyparty/types';
import { uploadFile } from '../copyparty/up2k';
import type { SqliteDb } from '../db/adapter';
import * as fileStateDao from '../db/file_state';
import { clampConcurrency, getJob } from '../db/jobs';
import * as runsDao from '../db/runs';
import type {
  ErrorPhase,
  FileStateRow,
  RunRow,
  RunStatus,
  RunTrigger,
} from '../db/types';

import { dateSubdir } from './path-organization';
import { ProgressBus } from './progress';
import * as runControl from './run-control';
import { PacerAbortedError, type Pacer } from './throttle';
import type { SourceWalker, WalkerEntry } from './walker/types';

// v1 retry policy — hard-coded. Applied at the HTTP call level (handshake +
// chunk POST). Auth errors (401/403) are not retryable and bubble up as
// wholesale run failures; everything else (network errors, 5xx) retries
// with the backoff below and then becomes a per-file failure. 3 attempts →
// 2 inter-attempt sleeps, hence 2 entries.
const HTTP_RETRY_ATTEMPTS = 3;
const HTTP_RETRY_BACKOFF_MS = [1000, 2000];

// How often mid-run counters are flushed to the `runs` row. The live UI reads
// the in-memory ProgressBus, but persisting periodically means (a) DB-backed
// screens (run detail, history) reflect progress without waiting for the run to
// finish, and (b) a run interrupted by an app kill keeps its partial numbers.
const COUNTER_PERSIST_INTERVAL_MS = 1000;

export interface EngineOptions {
  db: SqliteDb;
  walker: SourceWalker;
  client: CopypartyClient;
  fileSource: FileSource;
  progress?: ProgressBus;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * When present, the scan phase keeps only entries whose `localPath` is in this
   * set. Used by retry-failed to re-run a job scoped to one run's failed files.
   */
  filterPaths?: Set<string>;
  /**
   * Bandwidth limiter, shared by the whole worker pool. Supplied by the
   * triggers (`createSettingsPacer`, throttle-device.ts) the same way
   * `fileSource` is; absent means no limit, which is what the unit tests want.
   */
  pacer?: Pacer;
}

/**
 * Run one sync job end-to-end. See `docs/initial-plan.md` "Sync pipeline".
 *
 * Phase 3 scope: SAF source, short-circuit on (size, mtime) match, per-file
 * errors go to `run_errors` and the run continues; 401/403 fail the whole
 * run. `rehash_interval_days` is recorded on the job but not yet acted upon
 * — the re-hash path lands in phase 8 along with delete-propagation.
 *
 * Throughput: the run is two phases. A **scan** pass drains the walker,
 * short-circuiting files whose (size, mtime) still matches `file_state`, into
 * an array of files that genuinely need work (exact `totalFiles`/`totalBytes`
 * for that work, not for everything walked). Then an **upload** pass runs up to
 * `job.max_concurrency` of them in parallel via a fixed-size worker pool.
 */
export async function runJob(
  opts: EngineOptions,
  jobId: number,
  trigger: RunTrigger = 'manual',
): Promise<RunRow> {
  const progress = opts.progress ?? new ProgressBus();
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const retryingClient = withRetry(opts.client, sleep);
  // One pacer per run, shared by every worker — the duty cycle is a property of
  // the link, not of a single file.
  const pacer = opts.pacer;

  const job = await getJob(opts.db, jobId);
  if (!job) throw new Error(`job ${jobId} not found`);

  const runId = await runsDao.startRun(opts.db, { job_id: jobId, trigger });
  // Register the cancel controller *before* publishing the run to the UI, so a
  // cancel can never race ahead of the signal existing. The signal is threaded
  // into every fetch to tear down in-flight uploads on cancel/timeout.
  const signal = runControl.register(runId);
  const startedAt = now();
  progress.startRun({ runId, jobId, trigger, startedAt });

  // Counters shared across the worker pool. JS is single-threaded and these
  // are only mutated synchronously between awaits, so plain `++` is race-free.
  let scanned = 0;
  let uploaded = 0;
  let skipped = 0;
  let failed = 0;
  let bytesUploaded = 0;
  let bytesDeduped = 0;
  // First fatal (401/403) error: stops the pool scheduling new files; in-flight
  // uploads are allowed to settle.
  let fatal: unknown = null;

  // Throttled persistence of the live counters to the `runs` row (see
  // COUNTER_PERSIST_INTERVAL_MS). `finishRun` writes the authoritative final
  // values, so this only needs to keep the mid-run snapshot fresh-ish.
  let lastPersistedAt = 0;
  const persistCounters = async (force = false): Promise<void> => {
    if (!force && now() - lastPersistedAt < COUNTER_PERSIST_INTERVAL_MS) return;
    lastPersistedAt = now();
    await runsDao.updateRunCounters(opts.db, runId, {
      files_scanned: scanned,
      files_uploaded: uploaded,
      files_skipped: skipped,
      files_failed: failed,
      bytes_uploaded: bytesUploaded,
      bytes_deduped: bytesDeduped,
    });
  };

  try {
    progress.setPhase('scanning');
    const existing = await loadFileState(opts.db, jobId);

    // Scan pass: drain the walker into an array of files that actually need
    // work. Entries are tiny (uri, path, size, mtime) so even a 50k-asset
    // camera roll is fine in memory.
    //
    // The (size, mtime) skip decision happens HERE rather than per-file in the
    // upload phase, because it is what makes the denominator honest: a job
    // where 9,900 of 10,000 files are already synced used to publish all 10,000
    // as the total and then race the bar to 97% in seconds, which made the
    // progress bar and every ETA derived from it meaningless. `existing` is
    // already loaded above, so this costs one Map lookup per entry.
    const entries: WalkerEntry[] = [];
    let totalBytes = 0;
    for await (const entry of opts.walker.walk(job.source_uri)) {
      if (runControl.isCancelRequested(runId)) break;
      // Retry-failed scopes the run to a prior run's failed files.
      if (opts.filterPaths && !opts.filterPaths.has(entry.localPath)) continue;
      // `scanned` counts everything walked, so run history keeps its meaning.
      scanned++;
      if (isAlreadySynced(existing.get(entry.localPath), entry)) {
        skipped++;
        continue;
      }
      entries.push(entry);
      totalBytes += entry.size;
    }
    progress.bumpCounters({ scanned, skipped });
    progress.setTotals({ totalFiles: entries.length, totalBytes });
    // Persist the scan result immediately so a DB-backed screen shows the
    // denominator (and the skip count) while the upload phase runs.
    await persistCounters(true);

    // Load the bandwidth setting before any batch is planned — `maxBatchBytes`
    // is synchronous, so an unprimed pacer would size the first file's batches
    // at the unthrottled cap.
    await pacer?.prime();

    progress.setPhase('uploading');

    const processEntry = async (entry: WalkerEntry): Promise<void> => {
      const name = basename(entry.relativePath);
      // Date modes flatten the local subfolder structure into Y/M/D buckets;
      // 'flat' keeps the file's original relative directory.
      const subDir =
        job.path_organization === 'flat'
          ? dirname(entry.relativePath)
          : dateSubdir(entry.mtimeMs, job.path_organization);
      const remoteFolder = joinRemote(job.remote_path, subDir);
      const lmod = Math.max(0, Math.floor(entry.mtimeMs / 1000));

      progress.startFile({
        localPath: entry.localPath,
        name,
        size: entry.size,
        bytesUploaded: 0,
      });

      try {
        const result = await uploadFile({
          client: retryingClient,
          fileSource: opts.fileSource,
          localUri: entry.uri,
          name,
          remoteFolder,
          lmod,
          precomputedSize: entry.size,
          signal,
          pacer,
          onProgress: ({ bytesUploaded: b }) => {
            progress.updateFileBytes(entry.localPath, b);
          },
        });

        bytesUploaded += result.bytesUploaded;
        bytesDeduped += result.dedupSavedBytes;
        uploaded++;
        progress.bumpCounters({ uploaded: 1 });
        // Bytes the server already had never crossed the wire, so top the
        // overall bar up to this file's full size and tally the dedup saving.
        progress.recordDedup(result.dedupSavedBytes);

        await fileStateDao.upsertFileState(opts.db, {
          job_id: jobId,
          local_path: entry.localPath,
          size: entry.size,
          mtime_ms: entry.mtimeMs,
          wark: result.wark,
          last_hashed_at: now(),
          uploaded_at: now(),
        });
      } catch (e) {
        // A file torn down by cancellation isn't a failure — the run is being
        // stopped on purpose. Swallow it (the `finally` still ends the file) so
        // it isn't logged or counted as failed; the run finalizes as 'cancelled'.
        if (
          e instanceof RequestCancelledError ||
          e instanceof PacerAbortedError ||
          runControl.isCancelRequested(runId)
        ) {
          return;
        }
        const phase = classifyErrorPhase(e);
        const httpStatus = e instanceof Up2kError ? e.httpStatus : undefined;
        const message = e instanceof Error ? e.message : String(e);

        await runsDao.recordRunError(opts.db, {
          run_id: runId,
          local_path: entry.localPath,
          phase,
          http_status: httpStatus ?? null,
          message,
        });
        progress.recordError({ localPath: entry.localPath, phase, httpStatus, message });

        if (isFatalForRun(e)) {
          fatal ??= e;
        } else {
          failed++;
          progress.bumpCounters({ failed: 1 });
        }
      } finally {
        progress.endFile(entry.localPath);
      }
    };

    // Fixed-size worker pool: each worker pulls the next index until the array
    // is drained, a fatal error halts scheduling, or the run is cancelled.
    // In-flight uploads finish either way (between-files cancellation).
    let nextIndex = 0;
    const poolSize = Math.max(
      1,
      Math.min(clampConcurrency(job.max_concurrency), entries.length),
    );
    const worker = async (): Promise<void> => {
      while (!fatal && !runControl.isCancelRequested(runId)) {
        const idx = nextIndex++;
        if (idx >= entries.length) return;
        await processEntry(entries[idx]);
        await persistCounters();
      }
    };
    await Promise.all(Array.from({ length: poolSize }, () => worker()));
  } catch (e) {
    fatal = e;
    const message = e instanceof Error ? e.message : String(e);
    await runsDao.recordRunError(opts.db, {
      run_id: runId,
      local_path: '',
      phase: 'stat',
      http_status: null,
      message,
    });
    progress.recordError({ localPath: '', phase: 'stat', message });
  }

  progress.setPhase('finalizing');
  // A user-requested cancel wins over partial/ok (counters convey how much got
  // done); a fatal 401/403 still surfaces as a genuine failure. Read the cancel
  // state before the `finally` clears the registry entry.
  const status: RunStatus = fatal
    ? 'failed'
    : runControl.isCancelRequested(runId)
      ? 'cancelled'
      : failed > 0
        ? 'partial'
        : 'ok';
  try {
    await runsDao.finishRun(opts.db, runId, {
      status,
      files_scanned: scanned,
      files_uploaded: uploaded,
      files_skipped: skipped,
      files_failed: failed,
      bytes_uploaded: bytesUploaded,
      bytes_deduped: bytesDeduped,
    });
    progress.finishRun();

    const row = await runsDao.getRun(opts.db, runId);
    if (!row) throw new Error(`run ${runId} vanished before we could read it back`);
    return row;
  } finally {
    runControl.clear(runId);
  }
}

async function loadFileState(
  db: SqliteDb,
  jobId: number,
): Promise<Map<string, FileStateRow>> {
  const rows = await fileStateDao.listFileStateForJob(db, jobId);
  const m = new Map<string, FileStateRow>();
  for (const r of rows) m.set(r.local_path, r);
  return m;
}

/**
 * Cheap "nothing to do" test: we uploaded this exact path before and neither
 * its size nor its mtime has moved since. Deliberately does not hash — that is
 * the whole point of the short-circuit. `uploaded_at === null` means a prior
 * run hashed the file but never finished sending it, so it still needs work.
 */
function isAlreadySynced(
  prior: FileStateRow | undefined,
  entry: WalkerEntry,
): boolean {
  return (
    prior !== undefined &&
    prior.uploaded_at !== null &&
    prior.size === entry.size &&
    prior.mtime_ms === entry.mtimeMs
  );
}

function classifyErrorPhase(e: unknown): ErrorPhase {
  if (e instanceof Up2kError && e.phase !== 'ls') return e.phase;
  // 'ls' only fires from the pre-flight Test buttons, never from the engine.
  return 'upload';
}

function isFatalForRun(e: unknown): boolean {
  if (!(e instanceof Up2kError)) return false;
  // Auth errors kill the whole run — the password/cert is wrong and every
  // subsequent file will hit the same wall.
  return e.httpStatus === 401 || e.httpStatus === 403;
}

function isRetryable(e: unknown): boolean {
  // A deliberate cancel must never be retried.
  if (e instanceof RequestCancelledError) return false;
  if (e instanceof Up2kError) {
    if (e.httpStatus === undefined) return true; // network-ish
    if (e.httpStatus >= 500 && e.httpStatus < 600) return true;
    return false;
  }
  return true; // bare fetch rejection → treat as network transient
}

/**
 * Wrap the client so `handshake` and `uploadChunk` retry on transient
 * errors. Kept local to the engine on purpose — `CopypartyClient` stays a
 * thin HTTP wrapper; retry is a sync-pipeline concern.
 */
function withRetry(
  base: CopypartyClient,
  sleep: (ms: number) => Promise<void>,
): CopypartyClient {
  const attempt = async <T>(fn: () => Promise<T>): Promise<T> => {
    let lastErr: unknown;
    for (let i = 0; i < HTTP_RETRY_ATTEMPTS; i++) {
      try {
        return await fn();
      } catch (e) {
        lastErr = e;
        if (!isRetryable(e) || i === HTTP_RETRY_ATTEMPTS - 1) throw e;
        const idx = Math.min(i, HTTP_RETRY_BACKOFF_MS.length - 1);
        await sleep(HTTP_RETRY_BACKOFF_MS[idx]);
      }
    }
    throw lastErr;
  };

  // uploadFile only ever calls .handshake and .uploadChunk on the client;
  // everything else stays on `base`. Cast to satisfy the concrete type.
  const wrapped: Pick<CopypartyClient, 'handshake' | 'uploadChunk'> = {
    handshake: (folderPath, body, signal) =>
      attempt(() => base.handshake(folderPath, body, signal)),
    uploadChunk: (folderPath, headers, body, signal) =>
      attempt(() => base.uploadChunk(folderPath, headers, body, signal)),
  };
  return wrapped as CopypartyClient;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
}

function dirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

function joinRemote(base: string, sub: string): string {
  const b = base.replace(/\/+$/, '');
  if (!sub) return `${b}/`;
  return `${b}/${sub}/`;
}
