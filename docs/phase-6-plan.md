# Phase 6 — periodic background triggers, constraints, foreground service

## Context

Phase 6 is the first phase past the v1 ship bar. Goal: "user puts phone on a
charger overnight on Wi-Fi and wakes up to a fully-synced server." Everything
here is scheduling + permission wiring + UI — no changes to the up2k
protocol, the engine, or the walkers.

Phase 5 shipped the dashboard polish + per-file error surfacing (`master`
`d54c2c1`). The engine (`src/sync/engine.ts`) already treats one run as a
black-box async unit of work, so phase 6 layers scheduling on top without
touching its internals.

## User-confirmed scope adjustments (from kickoff exchange)

- **Per-job interval** (new `periodic_enabled`, `periodic_minutes` columns
  on `jobs`) with a **single** `expo-background-task` task that fans out:
  iterates all enabled jobs and picks the ones whose `last_run.started_at
  + periodic_minutes*60_000 ≤ now`. Matches WorkManager's one-task surface
  and its 15-minute minimum cadence.
- **Skipped-by-constraint ticks get a `runs` row** with `status='skipped'`
  and a new `skip_reason TEXT` column. Reasons:
  `'wifi_only' | 'data_saver' | 'charging_only' | 'already_running'`.
  The run is instantaneous (`started_at = finished_at`), all counters zero.
  Dashboard can show "hasn't synced in 3 days because data saver" without
  polluting `run_errors`.
- **Foreground service always-on** — started for every run regardless of
  trigger. Less code, no 10s-promotion race, single lifecycle. Auto-dismisses
  when the service stops, so brief manual runs flash briefly.
- **Rolled-up notification** — one persistent notification; title fixed,
  body updates in place with the active job. Matches the engine's
  single-slot run model.
- **Concurrent-run guard** — if `defaultProgressBus.getSnapshot().activeRun
  !== null`, the periodic tick writes a `skipped` row with
  `skip_reason='already_running'` and returns immediately.
- **Schedule UI** goes into `app/job/[id].tsx` between the Remote-path and
  Test-connection fields. "Next run" is a muted single line "in 23m · 2:34
  PM" inside the Schedule block.
- **POST_NOTIFICATIONS request** is lazy-at-save when the user first
  toggles periodic on.
- **Split into two PRs**: 6a (core + end-to-end runnable), 6b (notification
  polish, deep-link, skipped-run UX refinement, emulator-reboot test
  rigor, Data Saver native probe).

## PR 6a — core

### Data model changes (migration v2)

```sql
ALTER TABLE jobs ADD COLUMN periodic_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN periodic_minutes INTEGER NOT NULL DEFAULT 60;
ALTER TABLE runs ADD COLUMN skip_reason TEXT;
```

`jobs.periodic_minutes` default is 60 — picked only because it's a sane
value for a user who enables periodic without touching the interval input;
effectively unused while `periodic_enabled=0`.

`runs.status` typing widens to include `'skipped'`. The column has no
`CHECK` constraint in migration v1, so no SQL-level change is needed — TS
type only. Existing dashboards that treat `status` as an opaque string
keep working; the StatusDot helpers learn a new color.

### Types

```ts
// src/db/types.ts
export type RunStatus = 'running' | 'ok' | 'partial' | 'failed' | 'skipped';
export type SkipReason =
  | 'wifi_only'
  | 'data_saver'
  | 'charging_only'
  | 'already_running';

export interface JobRow {
  // …existing fields unchanged…
  periodic_enabled: number;   // 0 | 1
  periodic_minutes: number;   // integer minutes; floor 15 at UI
}

export interface RunRow {
  // …existing fields unchanged…
  skip_reason: string | null; // populated iff status='skipped'
}
```

### New DAO

```ts
// src/db/runs.ts
export interface RecordSkippedRunInput {
  job_id: number;
  trigger: RunTrigger;      // always 'periodic' in practice
  skip_reason: SkipReason;
}
export async function recordSkippedRun(
  db: SqliteDb,
  input: RecordSkippedRunInput,
): Promise<number>;
```

Writes an instantaneous `runs` row: `started_at = finished_at = now()`,
`status='skipped'`, `skip_reason` set, counters all zero. Returns the new
run id for logging.

### Constraint gate (pure TS + live probe)

```ts
// src/sync/constraints.ts
export interface ConstraintState {
  networkType: 'wifi' | 'cellular' | 'other' | 'none';
  isDataSaverOn: boolean;
  isCharging: boolean;
}
export type ConstraintDecision = { pass: true } | { pass: false; reason: SkipReason };

export function evaluateConstraints(
  job: Pick<JobRow, 'wifi_only' | 'respect_data_saver' | 'charging_only'>,
  state: ConstraintState,
): ConstraintDecision;

// src/sync/constraints.native.ts
export async function readConstraintState(): Promise<ConstraintState>;
```

- `wifi_only` → `networkType === 'wifi'` required.
- `respect_data_saver` → `isDataSaverOn === false` required.
- `charging_only` → `isCharging === true` required.
- All pass → `{ pass: true }`.

Evaluation order matters for the reason label when multiple constraints
fail; pick the order above so the most meaningful reason wins (`wifi_only`
before `data_saver`).

**Live probe** (`constraints.native.ts`):
- `expo-network` → `NetworkStateType.WIFI / CELLULAR / NONE / UNKNOWN` maps
  to `networkType`.
- `expo-battery` → `getBatteryStateAsync() === CHARGING || FULL` → `isCharging`.
- `isDataSaverOn`: **stubbed `false`** in PR 6a. Proper detection requires
  `ConnectivityManager.getRestrictBackgroundStatus()` — a Kotlin native probe.
  Ships in PR 6b. Schema + UI + tests all honor the toggle today; the probe
  just never says Data Saver is on, so `respect_data_saver` is effectively
  a no-op on device until 6b. Explicitly called out in the Schedule UI hint.

### Interval math

```ts
// src/sync/scheduler.ts
export function isJobDueForPeriodic(
  job: Pick<JobRow, 'periodic_enabled' | 'periodic_minutes'>,
  lastRunStartedAt: number | null,
  now: number,
): boolean;
```

Returns true iff `periodic_enabled === 1` AND (lastRunStartedAt === null OR
`now - lastRunStartedAt >= periodic_minutes * 60_000`). Pure TS, unit-tested.

Note: `lastRunStartedAt` is the most recent run **regardless of status** —
including `skipped`. This prevents a rapid-fire scenario where a 15-min
interval ticks every 15 min, skips because no Wi-Fi, then the next tick
fires because the last *succeeded* run is hours old. We want the cadence
gated by *tick* history, not success history.

### Scheduler

```ts
// src/sync/scheduler.ts
export const PERIODIC_TASK_NAME = 'copyparty-periodic';
export const PERIODIC_MIN_INTERVAL_MIN = 15;

export function definePeriodicTask(): void;           // calls TaskManager.defineTask
export async function syncPeriodicRegistration(db: SqliteDb): Promise<void>;
```

- `definePeriodicTask()` is called **once at module load** in
  `app/_layout.tsx` (not inside a component) — TaskManager requires tasks
  to be registered before React mounts.
- `syncPeriodicRegistration` runs on app mount and after any job
  create/update/delete: checks if any job has `periodic_enabled=1`;
  if yes, `BackgroundTask.registerTaskAsync(TASK_NAME, { minimumInterval:
  PERIODIC_MIN_INTERVAL_MIN })`; if no, `unregisterTaskAsync`.
- The task body lives in `src/sync/triggers/periodic.ts` (see below) and
  is imported into the scheduler module for `defineTask`.

### Periodic trigger (task body)

```ts
// src/sync/triggers/periodic.ts
export async function runPeriodicTick(db: SqliteDb): Promise<void>;
```

Flow:
1. `listJobs(db)` → filter `periodic_enabled === 1`.
2. For each candidate, `getLatestRunForJob` → `isJobDueForPeriodic`.
3. If `defaultProgressBus.getSnapshot().activeRun !== null` → for each
   due job, `recordSkippedRun('already_running')`; return.
4. `readConstraintState()` once, up-front.
5. For each due job: `evaluateConstraints(job, state)`. If fail, record
   skipped row with that reason. If pass, `runJob(...)` wrapped in
   `withForegroundService(job.name, …)`. Runs are sequential (same
   single-slot model as manual).
6. Errors escape no further than per-job (a thrown runJob becomes a
   recorded run error; a thrown foreground-service start becomes a
   logged warning — we still record a skipped row with
   `reason='already_running'` in that defensive branch is wrong, so we
   instead log and continue).

Entry point into the TaskManager is wired in `scheduler.ts`:

```ts
TaskManager.defineTask(PERIODIC_TASK_NAME, async () => {
  const db = await SQLite.openDatabaseAsync(DB_NAME);
  await configureConnection(db);
  await runPeriodicTick(db);
  return BackgroundTaskResult.Success;
});
```

DB open in the task is independent of the React-side `SQLiteProvider` —
background tasks can fire when no React tree exists.

### Foreground service

```ts
// src/sync/foreground.ts
export async function setupNotificationChannel(): Promise<void>;
export async function withForegroundService<T>(
  jobName: string,
  fn: () => Promise<T>,
): Promise<T>;
```

- Channel: `sync-foreground`, importance LOW (no sound), persistent.
- Notification: title "copyparty", body "Syncing: <jobName>", ongoing,
  no tap-action wired in 6a (deferred to 6b).
- Notification id is a constant (`FOREGROUND_NOTIF_ID = 1`) so each new
  run replaces the previous body.
- `finally` dismisses. If dismiss fails (device sleeping), it's harmless —
  the next run overwrites.

`expo-notifications` presentNotification + scheduleNotificationAsync handle
the persistent channel; to get the actual Android foreground-service
lifecycle we rely on the plugin's `androidMode: 'default'` + ongoing flag.
Full native foreground-service binding (a dedicated
`ForegroundService` class) is out of scope for 6a; the ongoing
notification is sufficient to keep the app process alive during a
WorkManager task, which is the only scenario where OS kill is a real risk.

Note to self: on Android 14+, `FOREGROUND_SERVICE_DATA_SYNC` must be
declared, which we do in app.json.

### Manual trigger update

`src/sync/triggers/manual.ts` wraps its `runJob(…)` call in
`withForegroundService(job.name, …)`. Behavior now matches periodic
exactly.

### app.json additions

```json
"android": {
  "permissions": [
    "FOREGROUND_SERVICE",
    "FOREGROUND_SERVICE_DATA_SYNC",
    "POST_NOTIFICATIONS",
    "ACCESS_NETWORK_STATE"
  ]
},
"plugins": [
  …existing…,
  ["expo-notifications", {
    "icon": "./assets/images/notification-icon.png",
    "color": "#0a7ea4"
  }],
  "expo-background-task"
]
```

(Icon asset deferred to 6b if we don't have one; the plugin accepts no
`icon` key fine.)

### package.json additions

- `expo-notifications` (peer `~0.32.x` for SDK 54)
- `expo-background-task` (peer `~0.4.x`)
- `expo-task-manager` (peer `~14.x`)
- `expo-network` (peer `~8.x`)
- `expo-battery` (peer `~10.x`)

Exact versions resolved at install time via `npx expo install`. **Dev
client must be rebuilt** (`nix develop --command bash -c 'npx expo
run:android'`) after install — matches the clipboard-dep story from phase
5.

### UI — Schedule section in `app/job/[id].tsx`

Inserted between the Remote-path input and the Test-connection button:

```
┌─ Schedule ──────────────────────────────────┐
│  [✓] Periodic background sync               │
│  Every [___] minutes   (min 15)             │
│                                             │
│  [✓] Wi-Fi only                             │
│  [✓] Respect Data Saver                     │
│  [ ] Charging only                          │
│                                             │
│  Next run: in 23m · 2:34 PM                 │
└─────────────────────────────────────────────┘
```

- "Periodic background sync" toggle drives `periodic_enabled`. When toggled
  on for the first time, we request `POST_NOTIFICATIONS` via
  `Notifications.requestPermissionsAsync()` **before** saving. If denied,
  the toggle reverts with an alert explaining why.
- Interval input is a numeric TextInput with a guard: values < 15 snap up
  to 15 on blur and trigger a muted "Minimum 15 minutes" hint.
- Constraint toggles drive `wifi_only`, `respect_data_saver`,
  `charging_only`. `respect_data_saver` shows a small `(best-effort;
  improving soon)` hint until 6b lands the native probe.
- "Next run" is computed live from `latestRun.started_at + periodic_minutes
  * 60_000` (or "shortly" if no latestRun). Relative label (`in 23m`, `in
  1h 14m`, `overdue`) + absolute time. Hidden if `periodic_enabled=0`.
- Save wires: `updateJob` includes the new fields; then
  `syncPeriodicRegistration(db)` is called before `router.back()`.

StatusDot in this file + `app/(tabs)/index.tsx` grows a branch for
`'skipped'` → grey-blue `#6a8caf`. Run-history rows render "skipped" as a
status string already (it's a free-text TEXT column).

### App launch wiring

In `app/_layout.tsx`:

- **Module scope** (above the component): `definePeriodicTask()`.
- **Inside the component**, guarded by a `useEffect` on first render:
  `syncPeriodicRegistration(db)` — uses a small hook that reads
  `useSQLiteContext()` inside a child component so the DB is guaranteed
  open.

Adding a third `Stack.Screen` is not needed in 6a — job edit already
exists.

### Unit tests

- `tests/unit/sync/constraints.test.ts`:
  - Every combination of toggles + state → expected decision.
  - Reason priority: `wifi_only` before `data_saver` before
    `charging_only`.
- `tests/unit/sync/scheduler.test.ts`:
  - `isJobDueForPeriodic`: disabled → never; enabled + no last run →
    always; enabled + last run older than interval → due; within interval
    → not due; exactly at the boundary → due.
- `tests/unit/db/jobs.test.ts`: new periodic fields round-trip.
- `tests/unit/db/runs.test.ts`: `recordSkippedRun` writes a complete row
  with `started_at === finished_at`, `status='skipped'`, `skip_reason`
  set, counters zero.

Engine / integration tests unchanged.

### Manual verification on emulator

Same discipline as phase 5. From repo root:

```
npm run test:integration:up
nix develop --command bash -c 'npx expo run:android'
adb shell monkey -p com.anonymous.copypartyclient -c android.intent.category.LAUNCHER 1
```

Verifications (screenshot each):

1. **schedule-ui** — open a job, toggle Periodic on, verify the permission
   prompt appears, toggles save, next-run line updates.
2. **periodic-tick-runs** — set interval to 15, wait (or force-run via
   `adb shell cmd jobscheduler run -f com.anonymous.copypartyclient 1001`
   equivalent — `expo-background-task` exposes
   `BackgroundTask.triggerTaskWorkerForTestingAsync` in dev), verify a
   `runs` row appears with `trigger='periodic'` and uploads happen.
3. **wifi-off-skip** — disable Wi-Fi, force a periodic tick, verify a
   `runs` row with `status='skipped'`, `skip_reason='wifi_only'`.
4. **foreground-service-notification** — start a long manual sync,
   background the app, verify persistent notification is visible and the
   run completes without being killed.
5. **reboot-restore** — reboot the emulator, relaunch the app, verify
   `syncPeriodicRegistration` re-registers the task.

## PR 6b — polish

Out of scope for 6a, tracked here so the split is explicit:

- ~~**Data Saver native probe**~~ — DONE 2026-07-04
  (`feat/background-sync-reliability`): `modules/copyparty-sync`
  `getDataSaverStatus()` via `ConnectivityManager.getRestrictBackgroundStatus()`,
  wired into `readConstraintState()`.
- **Notification content polish** — phase-aware ticker body ("Uploading
  12/234: camera_roll/IMG_0001.jpg"), rolled-up format when >1 eligible
  job ("Syncing 3 jobs · currently Camera backup").
- **Tap-to-deep-link** — notification tap routes to `/job/{id}` when 1
  job running, `/(tabs)/index.tsx` otherwise. Uses
  `Notifications.addNotificationResponseReceivedListener`.
- ~~**Dashboard skipped-run UX**~~ — DONE 2026-07-04
  (`feat/background-sync-reliability`): `skipReasonLabel()` shown in job
  run history + last-run summary; the "why isn't it syncing" banner became
  the dashboard background-sync health card.
- **Emulator-reboot test rigor** — scripted adb reboot sequence with
  expected-state assertions.

## Out of scope for phase 6 (deferred further)

- MediaStore ContentObserver (phase 7).
- Delete-propagation (phase 8).
- Periodic full re-hash scheduler (phase 8).
- Calendar pickers, quiet hours.
- iOS port of the foreground service (iOS has no equivalent; phase 6 UI
  should gracefully hide the Schedule block with a "Android only" hint on
  iOS — `Platform.OS === 'android'` check, one-liner).
