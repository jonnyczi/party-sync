import { MAX_STITCH_BYTES } from '../copyparty/up2k';
import { BANDWIDTH_SHARES, type BandwidthMode } from '../db/settings';

/**
 * Upload bandwidth limiter.
 *
 * Android has no API for this. An app cannot mark its traffic low-priority:
 * `TrafficStats.setThreadStatsTag` is accounting only, DSCP via
 * `Socket.setTrafficClass` is ignored by Wi-Fi stacks and consumer routers, and
 * `ConnectivityManager.registerQosCallback` only observes 5G QoS sessions.
 * WorkManager's UNMETERED / requiresDeviceIdle decide *when* to run, not how
 * fast. So the limit has to be enforced here, in the upload loop.
 *
 * ## Duty cycling, not a byte cap
 *
 * The user picks a *share* of the link rather than a rate, so they needn't know
 * their uplink speed. After each chunk POST of duration `t` we idle for
 * `t * (1/share - 1)`, which converges on that share of whatever throughput the
 * connection is actually giving, and yields further when the link is already
 * busy. A saturated uplink is what makes browsing and streaming feel broken —
 * it fills the bottleneck queue and adds hundreds of ms of latency to every
 * other flow — so yielding is the goal, not precision.
 *
 * ## Why uploads serialise while throttled
 *
 * Per-stream duty cycling does not compose. Three independent 50% streams
 * occupy the link `1 - 0.5³ = 87.5%` of the time, not 50%. So while the limit
 * is active the pacer holds a run-wide mutex: at most one chunk POST in flight
 * across the whole worker pool. Files still progress in parallel for hashing,
 * handshakes and DB work — only the byte-pushing serialises. This makes the
 * wall-clock accounting exact and removes a class of aggregation bugs.
 * `job.max_concurrency` therefore has no effect on rate while throttled.
 *
 * ## Why the burst size shrinks too
 *
 * A single POST is unbreakable, so the smallest burst enforceable is one
 * batch. At the default 8 MiB stitch cap that is a ~1.1s full-rate blast on a
 * 60 Mbps link — precisely what makes a video stutter, no matter how long we
 * idle afterwards. While throttled we cap a batch at 1 MiB (~140ms), which is
 * short enough for stream buffers to absorb.
 *
 * ## Only while the phone is in use
 *
 * Throttling a sync nobody is waiting on helps nobody, so the limit engages
 * only when the screen is interactive. That does mean a sync you start by hand
 * while watching it is also limited; the escape hatch is setting Full speed.
 *
 * Pacing happens entirely *before* `fetch` is called, so it never eats into
 * `CHUNK_TIMEOUT_MS` — the request itself still runs at line rate.
 */

/** Burst ceiling while throttled. See "Why the burst size shrinks" above. */
export const THROTTLED_BATCH_BYTES = 1024 * 1024;

/**
 * Ceiling on a single idle. Keeps a pathologically slow POST (or one whose
 * measured time includes retry backoff) from stalling the run for minutes.
 */
export const MAX_IDLE_MS = 5000;

/** Idles shorter than this are not worth a timer round-trip. */
const MIN_IDLE_MS = 20;

/** How long a read of the setting / screen state is reused. */
const SETTING_TTL_MS = 3000;
const SCREEN_TTL_MS = 2000;

export interface Pacer {
  /**
   * Read the setting once up front. Must be awaited before the first
   * `maxBatchBytes()`, because that call is synchronous (it sizes a batch plan)
   * and would otherwise report the unthrottled cap until the first async read
   * landed — letting the first file of every run burst at full size.
   */
  prime(): Promise<void>;
  /**
   * Run one chunk POST under the limit. When inactive this is a bare call —
   * no gate, no delay, concurrency untouched.
   */
  run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T>;
  /** Byte ceiling for the next stitched batch. */
  maxBatchBytes(): number;
  /** Whether the limit is engaged right now (for tests and diagnostics). */
  isActive(): boolean;
}

export interface PacerDeps {
  /** Current mode. Re-read periodically so a mid-run change takes effect. */
  readMode: () => Promise<BandwidthMode>;
  /** Whether the screen is on. */
  isScreenOn: () => boolean;
  now: () => number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** Thrown out of an interrupted idle so the caller's cancel path takes over. */
export class PacerAbortedError extends Error {
  constructor() {
    super('paced wait aborted');
    this.name = 'PacerAbortedError';
  }
}

/**
 * Sleep that resolves early — by rejecting — when the run is cancelled.
 * Without this a cancel would sit through a multi-second idle, and queued
 * workers would keep waiting on a mutex nobody is going to release promptly.
 */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new PacerAbortedError());
  return new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      done();
      reject(new PacerAbortedError());
    };
    const timer = setTimeout(() => {
      done();
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort);
  });
}

/** Resolve with `p`, or reject as soon as `signal` aborts — whichever first. */
function raceAbort<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(new PacerAbortedError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new PacerAbortedError());
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(resolve, reject).finally(() =>
      signal.removeEventListener('abort', onAbort),
    );
  });
}

export function createPacer(deps: PacerDeps): Pacer {
  let mode: BandwidthMode = 'full';
  let modeReadAt = 0;
  let modeInFlight: Promise<void> | null = null;

  let screenOn = false;
  let screenReadAt = 0;

  /** Accumulated idle debt in ms, paid down before the next POST. */
  let owed = 0;

  // Mutex: a chain of promises each worker appends itself to.
  let tail: Promise<void> = Promise.resolve();

  const readModeNow = (t: number): Promise<void> => {
    modeReadAt = t;
    modeInFlight = deps
      .readMode()
      .then((m) => {
        mode = m;
      })
      .catch(() => {
        // A failed settings read must never break a sync; keep the last value.
      })
      .finally(() => {
        modeInFlight = null;
      });
    return modeInFlight;
  };

  /**
   * Refresh in the background once the TTL is up. Deliberately not awaited: the
   * previous value stays in use until it lands, which is fine for a preference
   * that only has to take effect "within a few seconds".
   */
  const refreshMode = (t: number): void => {
    if (t - modeReadAt < SETTING_TTL_MS || modeInFlight) return;
    void readModeNow(t);
  };

  const active = (): boolean => {
    const t = deps.now();
    refreshMode(t);
    if (mode === 'full') return false;
    if (t - screenReadAt >= SCREEN_TTL_MS) {
      screenReadAt = t;
      screenOn = deps.isScreenOn();
    }
    return screenOn;
  };

  return {
    isActive: active,

    prime: () => readModeNow(deps.now()),

    maxBatchBytes: () => (active() ? THROTTLED_BATCH_BYTES : MAX_STITCH_BYTES),

    async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      // Cheap once primed (modeReadAt is set, so this is a no-op); covers the
      // case of a caller that skipped prime().
      if (modeReadAt === 0) await readModeNow(deps.now());
      if (!active()) {
        // Debt accrued under a limit that has since been lifted is stale.
        owed = 0;
        return fn();
      }

      // Take the gate. Every waiter chains off `tail`, so they run in order and
      // exactly one POST is in flight.
      let release!: () => void;
      const mine = new Promise<void>((r) => {
        release = r;
      });
      const previous = tail;
      tail = tail.then(() => mine);
      try {
        // Abortable: on cancel a queued worker must not sit through the POST
        // ahead of it. Releasing on the way out keeps the chain unwedged —
        // `mine` is already resolved when the predecessor finally lands.
        await raceAbort(previous, signal);
      } catch (e) {
        release();
        throw e;
      }

      try {
        if (signal?.aborted) throw new PacerAbortedError();
        if (owed >= MIN_IDLE_MS) {
          const wait = Math.min(owed, MAX_IDLE_MS);
          owed -= wait;
          await deps.sleep(wait, signal);
        }
        const started = deps.now();
        const result = await fn();
        const elapsed = Math.max(0, deps.now() - started);
        const share = BANDWIDTH_SHARES[mode];
        owed = Math.min(owed + elapsed * (1 / share - 1), MAX_IDLE_MS);
        return result;
      } finally {
        release();
      }
    },
  };
}

// The real, device-backed pacer lives in `throttle-device.ts` — it needs
// react-native and the copyparty-sync module, which a Node test environment
// cannot parse. Triggers construct it and hand it to the engine, exactly as
// they do with `nativeFileSource` (src/copyparty/hash.native.ts). Keeping this
// module free of those imports is what makes the duty-cycle maths testable.
//
// It is deliberately NOT called `throttle.native.ts`: Metro treats a `.native`
// suffix as a platform *override* of the base module, so `import './throttle'`
// from inside it resolves back to itself and every export reads as undefined.
// That fails only on device — the Node test run resolves the plain file and
// passes. Cost a full build cycle to find; don't reintroduce it.
