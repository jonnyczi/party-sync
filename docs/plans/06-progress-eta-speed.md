# Plan 6 — Truthful progress, upload speed and ETA

**Branch:** `fix/progress-eta-speed` · **Depends on:** nothing · **Blocks:**
Plan 7 (bandwidth share) — that feature deliberately slows uploads, so the
readout has to be trustworthy before it lands or you cannot tell a working
throttle from a broken estimator.

## Problem

The remaining-time figure fluctuated wildly, at times into the **millions of
hours**, and the "rate" beside it was not upload speed.

Both came from one design decision: `ProgressBus.uploadedBytes` mixed three
different quantities — bytes actually POSTed, bytes the server already had
(dedup, credited in one lump at handshake time), and whole files skipped on a
`(size, mtime)` match (credited instantly). `hooks/use-eta.ts` then derived
*both* the displayed rate and the ETA from that single number.

Two distinct failure modes followed:

1. **Spikes.** A 1 GiB file deduping inside one 1 s sample reported ~1 GiB/s and
   collapsed the ETA to seconds.
2. **Blow-ups.** Any stretch with no byte movement — hashing a large file, a slow
   handshake, retry backoff — folded zeros into an EMA with `alpha = 0.3`. The
   rate decays as `0.7ᵏ`, so ~40 s of stillness divided it by ~10⁶ and
   `remaining / rate` produced millions of hours. `formatEta` printed it verbatim;
   there was no clamp.

Compounding both: the denominator counted every walked file. A job where 9,900
of 10,000 files were already synced published all 10,000 as the total, raced the
bar to ~99 % in seconds on skips alone, then crawled — so the ETA was
extrapolating from a rate that had nothing to do with the remaining work.

## Changes

### Two numerators (`src/sync/progress.ts`)

`ActiveRunSnapshot` gains `wireBytes` beside `uploadedBytes`:

- `updateFileBytes` advances **both** — it is the only mutator that touches
  `wireBytes`.
- `recordDedup` advances `uploadedBytes` and `dedupedBytes`, never `wireBytes`.
- `advanceUploaded` is **removed**; skipped files no longer enter the run at all.

Speed is now read from `wireBytes`, the bar and ETA from `uploadedBytes`.

### Honest denominator (`src/sync/engine.ts`)

The `(size, mtime, uploaded_at)` skip check moved from `processEntry` into the
scan loop, where the `file_state` map is already loaded. Extracted as
`isAlreadySynced()`.

- `scanned` counts **every entry walked** → `runs.files_scanned` keeps its
  meaning in run history (`app/run/[id].tsx`, `app/job/[id]/index.tsx`).
- `entries` holds only files that need work; `totalBytes` sums just those.
- `skipped` is known at scan time, so the counter and the DB row show it
  immediately instead of ticking up during the upload phase.

`totalFiles`/`totalBytes` live only on the progress bus, so this needed no
migration and does not rewrite history.

### Robust estimator (`src/sync/rate-estimator.ts`, new)

React-free and clock-injectable so the live UI and the notification updater share
one implementation, and so the pathological cases are unit-testable.

- **Speed** — mean over a 10 s window of `wireBytes`. Honest, smooth, and
  naturally reads ~0 during a long hash (rendered as nothing, never `0 B/s`).
- **ETA rate** — `max(windowedProgressRate30s, runAverage * 0.1)`. The run
  average cannot reach zero once anything has moved, which is the direct fix for
  the `0.7ᵏ` collapse; the 0.1 floor bounds a stall while still letting a genuine
  slowdown lengthen the ETA honestly (this matters for Plan 7).
- **Frozen while still** — the ETA is recomputed only when progress actually
  advances. Recomputing during stillness is precisely what inflated it: every
  idle sample dragged the windowed rate down and pushed the number up, so a run
  that merely paused looked like one that would never finish. `STALL_MS` (15 s)
  only decides when to *label* it stalled; after `ETA_DROP_MS` (60 s) the estimate
  is dropped rather than guessed.
- **Ceiling** — past 24 h the UI prints "over a day left" instead of a number.
- Existing suppression guards kept (4 s elapsed, 256 KiB progressed).

`hooks/use-eta.ts` is now just the 1 s sampling timer and the reset-on-new-run
behaviour. `formatEta`/`formatRate` moved to `rate-estimator.ts` (re-exported
from the hook) so the headless notification path renders the same strings
without pulling in React.

### Live speed in the ongoing notification

- **Native:** `updateForegroundSync(title, text)` on `copyparty-sync`, re-posting
  `SyncNotifications.ongoing` under `SyncForegroundService.NOTIF_ID`. Re-posting
  the same id is the sanctioned way to update a foreground-service notification —
  the `FOREGROUND_SERVICE_TYPE_DATA_SYNC` binding is on the *service*, so it
  survives. Like `areNotificationsEnabled`, this is a **new native function**: a
  JS-only reload against an older binary leaves the property undefined, so JS
  calls it as `CopypartySync?.updateForegroundSync?.(…)`.
- **JS:** `withForegroundService` takes an optional `ProgressBus`, samples it
  every 1 s and re-posts at most every 2 s, skipping the call when the rendered
  text is unchanged (Android drops same-id updates past a few per second, and each
  post is a binder round-trip). An in-flight post is never queued behind itself.
  Routes to `CopypartyNotify` on the service-refused fallback path — both write
  the same id on the same channel. Cleared in the existing `finally`.
- Text: `Syncing: Camera roll · 42% · 4.1 MiB/s · ~11m left`, dropping whatever
  isn't available yet.

All three triggers (`manual`, `periodic`, `retry`) pass `defaultProgressBus`.

## Verification

- `npm test` — 271 unit tests, including `tests/unit/sync/rate-estimator.test.ts`
  which pins all three original defects as regressions: a dedup lump must not
  register as wire throughput; 60 s of stillness must keep the ETA bounded and
  frozen; a genuine 10× slowdown must still lengthen it.
- `npx tsc --noEmit`, `npm run lint` — clean.
- `npm run test:integration` — 23 tests against the Dockerized copyparty
  (`--dedup`, real up2k), covering the moved skip logic end to end.
- Emulator: a mostly-synced job (bar/denominator describe real work, skip count
  appears at scan time), a mixed fresh/dedup job (rate stays plausible, ETA does
  not whipsaw), and the notification text via
  `adb shell dumpsys notification --noredact | grep -A5 copyparty`.

## Notes for the next session

- Files that dedup entirely are still credited in one lump — genuinely unknowable
  before the handshake. The estimator absorbs it; do not try to pre-compute it
  without a search handshake per file.
- `FLOOR_FRACTION = 0.1` is the one tuning knob worth revisiting once Plan 7 is
  in: it sets how much of a real slowdown the ETA is allowed to reflect.
