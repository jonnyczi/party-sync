# Plan 7 — Adaptive upload bandwidth share

**Branch:** `feat/bandwidth-share` · **Depends on:** Plan 6 (its speed readout is
the instrument this was verified with).

## Problem

While a sync runs, browsing and streaming on the phone degrade badly. A
saturating upload fills the bottleneck queue (bufferbloat) and adds hundreds of
ms of latency to every other flow.

**Android offers no fix for this.** An app cannot mark its traffic
low-priority or background-class:

- `TrafficStats.setThreadStatsTag()` is accounting only.
- DSCP via `Socket.setTrafficClass()` is ignored by Wi-Fi stacks, consumer
  routers and carriers.
- `ConnectivityManager.registerQosCallback` (API 31) only *observes* 5G QoS
  sessions; there is no request side.
- LEDBAT-style scavenger congestion control is a transport feature Android does
  not expose per-socket.

The OS levers that do exist — WorkManager's `UNMETERED` / `requiresDeviceIdle`,
Data Saver, the existing `wifi_only` / `charging_only` job toggles — decide
*when* a sync runs, not how fast. So the limit has to live in the upload loop.

## Design

### Adaptive share, not a byte cap

The user picks a share of the link (Full / Balanced ≈50% / Gentle ≈25%) rather
than a rate, so they needn't know their uplink speed. After each chunk POST of
duration `t`, the pacer idles `t * (1/share - 1)`. That converges on the chosen
share of whatever throughput the link is actually giving, and yields further
when the link is already busy — which is exactly the situation the feature
exists for.

### Only while the phone is in use

Throttling a sync nobody is waiting on helps nobody, so the limit engages only
when the screen is interactive. Overnight and idle syncs still run flat out.

This needs a native probe (`DeviceProbes.isScreenInteractive`, `PowerManager`
was already imported). RN's `AppState` cannot substitute: during a background
sync the app always reports `background`, so "screen off, nobody around" is
indistinguishable from "user is browsing in Chrome" — the exact case to throttle
for. Off-Android it falls back to `AppState.currentState === 'active'`, which is
one-directional (foreground implies screen on, not the reverse) so a background
sync there simply runs unthrottled.

Consequence worth knowing: a sync started by hand while watching it is limited
too. The settings copy says so; the escape hatch is Full speed.

### Uploads serialise while throttled

Per-stream duty cycling does not compose — three independent 50% streams occupy
the link `1 - 0.5³ = 87.5%` of the time. So while active the pacer holds a
run-wide async mutex: at most one chunk POST in flight across the worker pool.
Files still progress in parallel for hashing, handshakes and DB work (confirmed
on device: three files in flight during a throttled run); only the byte-pushing
serialises. `job.max_concurrency` therefore has no effect on rate while
throttled.

### The burst shrinks too

A POST is unbreakable, so the batch size *is* the smallest burst enforceable. At
the default 8 MiB stitch cap that is a ~1.1 s full-rate blast on a 60 Mbps link
— what makes a video stutter, no matter how long we idle afterwards. While
throttled a batch is capped at 1 MiB (~140 ms), short enough for stream buffers
to absorb. `planStitchedChunks` grew a defaulted `maxStitchBytes` parameter.

### Where it sits

- `src/sync/throttle.ts` — pure pacer (duty cycle, mutex, abortable waits).
- `src/sync/throttle-device.ts` — the RN/native wiring, injected by the triggers
  exactly as `nativeFileSource` is. **Not** `throttle.native.ts`: Metro treats
  `.native` as a platform *override* of the base module, so `import './throttle'`
  from inside it resolves back to itself and every export reads undefined. That
  fails only on device — the Node test run resolves the plain file and passes.
- `EngineOptions.pacer` is optional; absent means no limit.
- Pacing happens entirely before `fetch`, so it never eats into
  `CHUNK_TIMEOUT_MS` — the request itself still runs at line rate.
- `prime()` is awaited once after the scan: `maxBatchBytes()` is synchronous, so
  an unprimed pacer would size the first file's batches at the unthrottled cap.
- Setting lives in the existing `settings` KV table (no migration) and rides in
  backup bundles; each settings field parses independently so an older bundle
  applies what it has and leaves the rest alone.

## Verification

Unit (`tests/unit/sync/throttle.test.ts`, virtual clock): duty ratio at balanced
and gentle, convergence over 20 posts, idle cap, serialisation, gate survives a
throwing POST, abort before/inside the gate, live mode and screen changes, stale
debt discarded, burst cap. Plus settings accessors (including junk → `full`),
`planStitchedChunks` under a smaller cap, and an engine test asserting every
chunk POST goes through the pacer and the cap forces four POSTs instead of one.

On the emulator against the dockerized copyparty, 60 fresh files / 100 MB:

| condition | observed |
|---|---|
| Full speed (Plan 6 baseline) | ~3.5 MiB/s |
| Gentle, screen **on** | 542–743 KiB/s (~20%) |
| Gentle, screen **off** (mid-run) | 2.0 → 3.3 → 4.5 MiB/s within ~15 s |

~20% against a nominal 25% is expected and documented: repeatedly idling
collapses the TCP congestion window, so real throughput sits below the nominal
share. The goal is yielding, not precision.

Cancel during a throttled run: `status='cancelled'`, 12/30 files done, **0
failures and 0 `run_errors`** — `PacerAbortedError` is recognised as a
cancellation, not a per-file failure — torn down in <4 s.

## Notes for the next session

- **Minimum burst is one chunk.** `up2kChunksize` grows the chunk until
  `nchunks <= 256`, so files up to ~256 MiB use 1 MiB chunks (photos, typical
  phone video) but a 4 GiB file lands on ~16 MiB chunks, an irreducible burst.
  Splitting further needs `X-Up2k-Subc`, deliberately out of scope and easy to
  get wrong (it is the *opposite* of chunk stitching — see the note in up2k.ts).
- **Retry backoff counts as busy time**, since the pacer wraps the retry-wrapped
  client. It errs gentle and is bounded by `MAX_IDLE_MS`.
- Not built, by explicit decision: notification pause action, dashboard quick
  toggle, `NetworkType.UNMETERED` scheduling, absolute byte caps, per-job
  override.
