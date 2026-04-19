# Phase 5 — dashboard polish + per-file error surfacing

## Context

Phase 5 is the last phase of the v1 ship bar (`docs/initial-plan.md` phases
1–5). The bar is "this is what ships", not "enough to continue."

Today the dashboard (`app/(tabs)/index.tsx`) is a 3-card summary grid plus a
list of jobs with a status dot — baseline work from phase 3. The only
surfacing of per-file errors is the "top 5 of last run" panel on the job edit
screen, which disappears after the next run. That's below the v1 promise that
errors are "actually actionable."

This phase polishes the dashboard, gives per-file errors a durable home, and
lands a run-detail screen that makes run history tappable.

**User-confirmed scope adjustments** (from the phase-5 kickoff exchange):

- Build a dedicated run-detail screen `app/run/[id].tsx`.
- Surface "recent errors across all jobs" on the dashboard (new DAO joining
  `run_errors → runs → jobs`).
- **Implement** bytes-uploaded-over-time on the dashboard (user asked for it
  even though I'd flagged it as deferrable).
- One PR for the lot.

## Note on in-flight edit

Before plan mode activated, one edit landed on `src/db/runs.ts` adding the
new DAOs (`countRunErrors`, `listRunsSince`, `listRecentErrors`). It matches
the spec in this plan. If you want a clean slate before approval, revert
that file; otherwise it's aligned and will stay.

## Files touched

New:
- `app/run/[id].tsx` — run-detail screen.
- `src/sync/aggregates.ts` — pure-TS selector(s) over run rows.
- `tests/unit/sync/aggregates.test.ts` — selector tests.

Modified:
- `src/db/runs.ts` — add `countRunErrors`, `listRunsSince`,
  `listRecentErrors` (+ `RecentErrorRow` type). Already applied.
- `tests/unit/db/runs.test.ts` — coverage for the three new DAOs.
- `app/_layout.tsx` — register `run/[id]` in the root `Stack`.
- `app/(tabs)/index.tsx` — substantial rewrite (see layout spec below).
- `app/job/[id].tsx` — make run-history rows `Pressable` → `/run/{id}`;
  long-press on error rows copies `local_path`.

Not touched:
- `src/sync/progress.ts`, `hooks/use-sync-progress.ts`,
  `components/sync-banner.tsx` — already sufficient. Banner stays rendered
  on jobs/settings; dashboard replaces it with a full-bleed hero card so we
  don't double up.
- Engine / integration tests — phase 5 is UI + DAO only.

## New DAOs (signatures)

```ts
// src/db/runs.ts
export async function countRunErrors(db, runId): Promise<number>;

export async function listRunsSince(
  db,
  sinceMs: number,
  limit = 500,
): Promise<RunRow[]>;

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
  db,
  limit = 50,
): Promise<RecentErrorRow[]>;
```

`listRecentErrors` joins `run_errors → runs → jobs`, ordered by
`r.started_at DESC, e.id DESC`. Uses existing indices
(`idx_run_errors_run`, `idx_runs_job_started`).

## Pure-TS selector

`src/sync/aggregates.ts` holds UI-layer aggregation logic so it's testable
without touching SQLite's timezone machinery:

```ts
export interface DayBucket { day: string; bytes: number; }

// Returns `days` contiguous local-day buckets ending at `now`'s local day.
// Empty days are zero-filled so the bar chart has a fixed length.
export function bucketBytesByDay(
  runs: Pick<RunRow, 'started_at' | 'bytes_uploaded'>[],
  days: number,
  now: number,
): DayBucket[];

// Sums over a filtered run slice. Single O(n) pass.
export interface LastNAgg {
  uploaded: number;
  failed: number;
  bytes: number;
}
export function aggregateRuns(
  runs: Pick<RunRow, 'files_uploaded' | 'files_failed' | 'bytes_uploaded'>[],
): LastNAgg;
```

Day key: `YYYY-MM-DD` from `new Date(ms).getFullYear()/getMonth()+1/getDate()`
(pad-2). This is intentionally local-time; tests pass explicit `now` so no TZ
flakiness.

## Dashboard layout (top → bottom)

1. **Header** — unchanged title.
2. **Hero slot** — single card that swaps on `progress.activeRun`:
   - *Running:* phase label, active filename, progress bar, counters
     (uploaded / skipped / failed), up to 3 latest errors inline, tap →
     `/job/{id}`. Replaces the SyncBanner on this screen only.
   - *Idle + has runs:* most recent run across all jobs (job name + status
     dot + localized time + `u↑/s=/f✗` counters + bytes). Tap → `/run/{id}`.
   - *Idle + no runs + has jobs:* mini "Tap a job below to sync now" row.
3. **Stats strip (last 24h)** — three cells: Uploaded, Failed, Bytes. Built
   by `aggregateRuns(runs.filter(r => r.started_at >= now - 24h))`. Hidden
   until at least one run exists.
4. **Bytes over time** — 7-day bars (`bucketBytesByDay(runs, 7, now)`). Tiny
   inline component (`<View>` columns, no chart dep). Hover-free — each bar
   shows its height; the most recent day is highlighted with `tint`. Label
   shows peak day formatted as bytes. Hidden until at least one run has
   `bytes_uploaded > 0`.
5. **Jobs** — unchanged row shape (name / remote path / status dot). Still
   taps into `/job/{id}`.
6. **Recent errors** — up to 10 most recent errors from `listRecentErrors`.
   Row: `{phase}  {job.name}:{basename(local_path)}  —  {message || HTTP n}`.
   Tap → `/run/{run_id}`. Long-press → copy `local_path` via Clipboard.
   Hidden when empty.
7. **Empty state** — when `jobs.length === 0`: two-step onboarding card
   ("1. Add a server" → `/(tabs)/settings`, "2. Create a job" →
   `/(tabs)/jobs`). CTAs render as `Pressable` rows with chevrons.

Data loading: `useFocusEffect` pulls `listJobs`, `listRunsSince(db, now -
7d)`, `listRecentErrors(db, 10)` in parallel. Refresh also fires when
`progress.activeRun` transitions from non-null → null (a run just finished)
so stats/errors update without a manual focus bump.

## Run-detail screen `app/run/[id].tsx`

- Params: `{ id: string }`. Parse to number; 404 if missing.
- Loads once on mount: `getRun`, parent `getJob`, `listRunErrors(db, runId)`,
  plus `getServer` for the job's server name.
- Layout:
  - Header: `{job.name} run` + status pill + started_at.
  - Summary block: counters + bytes + duration (`finished_at - started_at`).
  - Errors section: all errors for this run, rendered as rows with
    `phase / path / HTTP status / message`. Long-press copies path.
    Search/filter is out of scope; 100s of rows is fine as a `FlatList`.
  - Footer link: "Open job" → `/job/{job_id}`.
- Registered in `app/_layout.tsx` as a non-modal stack screen so the back
  button lands where the user came from (dashboard recent-errors or job
  history).

## Job-screen wiring

`app/job/[id].tsx` run-history rows become `Pressable` → `/run/{r.id}`. The
"latest run" panel's error rows get the same long-press-to-copy affordance.
No other changes.

## Unit tests

- `tests/unit/db/runs.test.ts`:
  - `countRunErrors` returns 0 / exact count.
  - `listRunsSince` filters by `started_at`, orders DESC, respects limit.
  - `listRecentErrors` returns errors across multiple jobs, joined with
    job name, ordered by run.started_at DESC then e.id DESC; respects
    limit.
- `tests/unit/sync/aggregates.test.ts`:
  - `bucketBytesByDay` returns `days` buckets ending at `now`'s local day,
    zero-fills gaps, sums multiple runs in the same day, ignores runs
    outside the window.
  - `aggregateRuns` sums over the provided slice correctly and returns
    zeros for an empty slice.

## Manual verification (against Docker copyparty)

From repo root:
```
npm run test:integration:up   # bring up dockerized copyparty
nix develop --command bash -c 'npx expo run:android'
adb shell monkey -p com.anonymous.copypartyclient -c android.intent.category.LAUNCHER 1
```

Then in-app, using the emulator, exercise each dashboard state and capture
a screenshot for each (`adb exec-out screencap -p | magick png:- -resize
50% -quality 80 tmp/shot-<state>.jpg`):

1. **idle-empty** — fresh install; onboarding card visible.
2. **idle-populated** — at least one successful run in history; stats strip
   + bytes-over-time + last-run hero populated.
3. **running** — kick off a sync on a medium folder; hero shows live
   progress; banner does not render on dashboard.
4. **partial-last-run** — point a job at a remote path that's read-only for
   some files (or drop a file mid-sync); verify hero shows partial status,
   recent-errors section populated, tap → run-detail screen shows the list,
   long-press copies a path.
5. **failed-last-run** — point a job at a non-existent server; hero shows
   failed status, recent-errors populated.

Also run `npm run lint` and `npm test` before commit.

## Out of scope (deferred per the plan)

- Periodic / background triggers (phase 6).
- ContentObserver (phase 7).
- Delete-propagation toggle UI (phase 8).
- Per-file retry from the UI — the engine already retries 3× transient
  failures; UI-driven single-file retry is feature creep vs. "just run the
  job again."
- Global / system notifications (phase 6).

## PR shape

One PR. The run-detail screen is the navigation target for the dashboard
error list and the job-screen history rows — splitting would leave
half-wired navigation.
