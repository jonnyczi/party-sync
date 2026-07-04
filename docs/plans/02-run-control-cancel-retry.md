# Plan 2 — Run control: cancel + retry-failed

**Branch:** `feat/run-control-cancel-retry`
**Order:** AFTER Plan 1 (`feat/engine-throughput-progress`) is merged — this
threads control through the concurrent upload loop Plan 1 introduces.

> ### Read first — shared context
> - **Android-first**; native modules are Android-only.
> - **Never hand-edit `android/`**; native config flows through `app.json` +
>   config plugins.
> - **De-Googled**: no Firebase/GMS; `scripts/scan-nonfree-apk.py` is a CI gate.
> - **Verify in the Android emulator** before committing (dockerized copyparty at
>   `http://10.0.2.2:3923`, `test`/`testpw`).
> - Run `npm run lint` and `npm test` before the PR.
>
> **Before coding, ask the user the "Open questions" at the bottom.**

## Context / why

A "Sync now" run has no stop button — a large run on the wrong network or to the
wrong path can't be aborted. And when files fail (per-file errors are recorded in
`run_errors` and the run continues), the run-detail screen lists them but offers
no way to re-attempt just those files. This plan adds **cancel** and a targeted
**retry-failed**.

## Locked decisions

- **Cancel only** — pause/resume is explicitly out of scope. Cancelling marks the
  run with a new terminal status `cancelled`.
- **Retry-failed** is a button on the **run-detail screen** that re-runs the job
  scoped to **that run's failed files** (the engine still skips already-uploaded
  files via the `(size, mtime)` short-circuit).

## Key files / what changes

- **New `src/sync/run-control.ts`** — a tiny singleton registry:
  `requestCancel(runId)`, `isCancelRequested(runId)`, `clear(runId)`. This is
  out-of-band because `runJobManual` doesn't return until the run finishes, so the
  UI can't pass a flag into an in-progress run.
- **`src/sync/engine.ts`** — in `runJob`, check `isCancelRequested(runId)` between
  files (and ideally between chunk batches). On cancel: stop scheduling new files,
  let in-flight files settle (or abort — see open questions), then `finishRun`
  with status `cancelled`. `clear(runId)` in a `finally`. Optionally thread an
  `AbortSignal` into `CopypartyClient.handshake`/`uploadChunk` (both use `fetch`,
  which supports `signal`) for near-instant abort; between-file granularity is
  acceptable for v1.
- **`src/sync/engine.ts` (`EngineOptions` / `runJob`)** — accept an optional
  `filterPaths?: Set<string>`. When present, the scan phase keeps only entries
  whose `localPath` is in the set. Used by retry.
- **`src/db/types.ts`** — add `'cancelled'` to `RunStatus` and `'retry'` to
  `RunTrigger`.
- **`src/db/runs.ts`** — add a query returning a run's distinct failed
  `local_path`s from `run_errors` (exclude the run-level rows whose `local_path`
  is empty).
- **New `src/sync/triggers/retry.ts`** — `retryRunFailures(db, runId)`: load the
  run + its job, build the failed-paths `Set`, then run the job with
  `trigger='retry'` and `filterPaths`. Mirror the structure of
  `src/sync/triggers/manual.ts` (`runJobManual`) including `withForegroundService`
  and `defaultProgressBus`.
- **`app/run/[id].tsx`** — a "Retry failed (N)" button shown when
  `run.files_failed > 0`, calling `retryRunFailures`; on success navigate to the
  new run (or refresh — see open questions).
- **`app/job/[id].tsx` + `app/(tabs)/index.tsx`** — render a **Cancel** button
  while a run is active (`useSyncProgress().activeRun`), calling
  `requestCancel(activeRun.runId)`. Handle the new `cancelled` status in the
  `StatusDot` / `StatusPill` / status-label helpers in each screen.

## Reuse

`runJobManual` pattern (`src/sync/triggers/manual.ts`), `withForegroundService`
(`src/sync/foreground.ts`), `defaultProgressBus`, `listRunErrors` / `finishRun`
(`src/db/runs.ts`), and the per-screen status-color helpers.

## Open questions for this session

1. **Cancel granularity** — between-files only (simple) vs `AbortSignal` plumbed
   through `CopypartyClient` (instant, more code). Suggest between-files for v1.
2. A `cancelled` run that already uploaded some files — keep status `cancelled`
   (suggested, counters tell the rest) or `partial`?
3. **Retry UX** — navigate into the newly-created retry run, or stay on the
   current screen with a toast/refresh?
4. Should the active-run **Cancel** button appear on the dashboard card too, or
   only on the job screen?
5. Confirm `retryRunFailures` should re-run via the same foreground-service +
   progress-bus path as a manual run (so it shows in the live UI).

## Verification

- **Unit (`npm test`):** engine honors `filterPaths` (only listed paths attempted);
  a cancel signalled mid-run yields status `cancelled` with correct counters.
- **Emulator:** start a large camera-roll sync, hit Cancel mid-run → status
  `cancelled`, foreground notification clears, no further uploads
  (verify server side with `curl -u test:testpw ".../?ls=..."`). Force some
  per-file failures (e.g. a remote path the account can't write), then
  "Retry failed" from run detail and confirm only those files re-upload and the
  new run links back to the job.
