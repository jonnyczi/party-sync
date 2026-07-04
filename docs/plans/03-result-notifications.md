# Plan 3 — Completion & failure notifications

**Branch:** `feat/result-notifications`
**Order:** AFTER Plan 1 (`feat/engine-throughput-progress`) is merged (it consumes
the final run summary, including the dedup-savings field Plan 1 adds). If Plan 2
(`feat/run-control-cancel-retry`) has also merged, add a Cancel action to the
ongoing-sync notification (see open questions).

> ### Read first — shared context
> - **Android-first**; native modules are Android-only.
> - **Never hand-edit `android/`**; native config flows through `app.json` +
>   config plugins.
> - **De-Googled — this plan is the most exposed to it.** No Firebase/GMS. Keep
>   using `modules/copyparty-notify` (androidx.core only). **Never** add
>   `expo-notifications` — its Android build pulls in Firebase Cloud Messaging,
>   which the `scripts/scan-nonfree-apk.py` CI gate will reject.
> - **Verify in the Android emulator** before committing.
> - Run `npm run lint` and `npm test` before the PR.
>
> **Before coding, ask the user the "Open questions" at the bottom.**

## Context / why

Background/periodic runs currently finish silently. The only notification is the
sticky "Syncing…" foreground-service notification posted by
`src/sync/foreground.ts` for the run's duration — there's no result summary or
failure alert. Users running scheduled backups want "Backup complete — N photos"
and, more importantly, to be told when a backup **failed**.

## Locked decisions

- Notify on **all completions and all failures** (manual + background).
- Notifications are **tappable** → deep-link to the run detail (or the job on a
  run-level failure). This requires extending the native module with a tap intent.
- A **global on/off toggle**, default **on**, in the Settings tab.

## Key files / what changes

- **`modules/copyparty-notify`** (Kotlin under `android/`, JS API under `src/`) —
  extend `notify(...)` to accept an optional **deep-link payload** and build a
  `PendingIntent` that launches `MainActivity` with that link, so a tap opens the
  app at the right route. Add a **second channel** (default importance, e.g.
  `copyparty-results`) distinct from the existing low-importance
  `copyparty-sync` ongoing channel. Stay androidx.core-only — **no Firebase/GMS**.
  (This module is an Expo native module; follow its existing `expo-module`
  structure. The `expo:expo-module` skill documents the Module DSL if needed.)
- **New `src/sync/notify-result.ts`** — `notifyRunResult(run, jobName)`: format a
  title/body (e.g. "Backup complete — 142 uploaded · 3 failed · 1.2 GiB", or a
  failure variant for status `failed`/`partial`) and call the module with a deep
  link to `/run/<id>`. No-op when `Platform.OS !== 'android'`, when the native
  module is null, or when the user's toggle is off.
- **Hook into run completion** — cleanest is to call `notifyRunResult` from the
  **triggers** after `runJob` returns: `src/sync/triggers/manual.ts`,
  `src/sync/triggers/periodic.ts`, and (if Plan 2 merged) `triggers/retry.ts`.
  This keeps the engine notification-agnostic. (Confirm in open questions.)
- **Deep linking** — ensure `app.json` `expo.scheme` is set and an expo-router
  route resolves the link; handle the **cold-start** case where the tap launches
  the app. `expo-linking` is already a dependency; typed routes are enabled.
- **Settings store (new)** — there is **no general settings store** yet. Add a
  small key-value `settings` table (migration v5 in `src/db/schema.ts`) with a
  typed accessor `src/db/settings.ts` (get/set a boolean). Add a "Notifications"
  toggle row to `app/(tabs)/settings.tsx`. Optionally include the setting in the
  backup export (`src/backup/*`).

## Reuse

`withForegroundService` / `ensureChannel` patterns (`src/sync/foreground.ts`),
`CopypartyNotify.setChannel` / `notify` / `dismiss`, `ensureNotificationPermission`
(`src/sync/notify-permission.ts`), and the summary fields already on `RunRow`
(`files_uploaded`, `files_failed`, `bytes_uploaded`, `status`, and
`bytes_deduped` from Plan 1).

## Open questions for this session

1. On a **run-level** (fatal/auth) failure with no specific file, deep-link to the
   **run** or the **job**? Suggest the run.
2. The user chose "all completions" — confirm they really want **manual-run
   successes** to notify too, given the UI already shows them on-screen (vs only
   background successes + all failures).
3. Settings store: confirm the new `settings` KV table approach and whether the
   toggle is included in backup export/import.
4. Notification **permission** (Android 13+ `POST_NOTIFICATIONS`) is currently
   requested when enabling periodic sync — confirm whether enabling result
   notifications should also prompt, and how to handle "denied".
5. If Plan 2 merged: add a **Cancel** action button to the ongoing sync
   notification (wire its PendingIntent to `requestCancel`)?

## Verification

- **Emulator:** run a job to completion → result notification appears → tapping it
  lands on the correct run detail (test both warm and cold start). Force a failure
  → failure notification. Toggle the setting off → no result notifications.
  Confirm a periodic/background run notifies.
- **Non-free gate:** run `scripts/scan-nonfree-apk.py` against a built APK (or via
  the Dagger flow) to confirm no `com.google.firebase`/`gms` classes were pulled
  in by the change.
