/**
 * Upload-speed and ETA estimator for the active run.
 *
 * Deliberately React-free and clock-injectable so the live UI
 * (`hooks/use-eta.ts`) and the ongoing-notification updater
 * (`src/sync/foreground.ts`) share one implementation, and so the pathological
 * cases below are unit-testable without rendering anything.
 *
 * It reads TWO numerators, which is the crux of the whole thing:
 *
 * - `wireBytes` — bytes that actually crossed the wire. Drives the displayed
 *   **speed**.
 * - `progressBytes` — wire bytes plus whole files credited at once when the
 *   server turns out to already have them (dedup). Drives the **ETA**, because
 *   a deduped file really is done and really did take almost no time.
 *
 * Deriving both from `progressBytes` (what the old EMA did) produced two
 * failure modes seen in the field:
 *
 *   1. A 1 GiB file deduping inside one sample window reported ~1 GiB/s and
 *      collapsed the ETA to seconds.
 *   2. Any stretch with no byte movement — hashing a large file, a slow
 *      handshake, retry backoff — folded zeros into an EMA with alpha 0.3. The
 *      rate decays as 0.7^k, so ~40 s of stillness divided it by ~10^6 and
 *      `remaining / rate` printed **millions of hours**.
 *
 * The fixes: separate numerators, a windowed mean instead of a decaying EMA,
 * and an ETA rate floored on the run-average (which cannot reach zero once
 * anything has moved), plus an explicit ceiling and stall state so the UI never
 * has to render an absurd number.
 */

/** Sample retention. The ETA window is the longest thing we look back over. */
const WINDOW_MS = 30_000;
/** Shorter window for the displayed speed — reacts faster than the ETA. */
const SPEED_WINDOW_MS = 10_000;

/**
 * Floor for the ETA rate, as a fraction of the run's average rate. Bounds a
 * stall at 10x the naive estimate instead of letting it run to infinity, while
 * still leaving room for a genuine slowdown (e.g. the bandwidth limiter
 * engaging) to lengthen the ETA honestly rather than being flattened away.
 */
const FLOOR_FRACTION = 0.1;

/** Beyond this the number stops being information; the UI says "over a day". */
const ETA_CEILING_MS = 24 * 60 * 60 * 1000;

/** No progress for this long → `stalled`; the UI holds the last ETA. */
const STALL_MS = 15_000;
/** No progress for this long → give up and show no ETA at all. */
const ETA_DROP_MS = 60_000;

/** Don't estimate until the run has this much history + progress behind it. */
const MIN_ELAPSED_MS = 4000;
const MIN_BYTES = 256 * 1024;

export interface RateSample {
  /** Bytes genuinely POSTed so far this run. */
  wireBytes: number;
  /** Bytes accounted for so far (wire + dedup). */
  progressBytes: number;
  /** Denominator for the run: bytes of real work. */
  totalBytes: number;
  /** Run start, epoch ms. */
  startedAt: number;
  /** Now, epoch ms. */
  now: number;
}

export interface RateEstimate {
  /** Smoothed wire throughput in bytes/sec; null before enough history. */
  rateBytesPerSec: number | null;
  /** Estimated ms remaining; null while suppressed or long-stalled. */
  etaMs: number | null;
  /** `etaMs` was clamped at the ceiling — show "over a day left". */
  capped: boolean;
  /** No progress for a while; `etaMs` is the last good value, not a fresh one. */
  stalled: boolean;
}

interface Point {
  t: number;
  wire: number;
  progress: number;
}

const EMPTY: RateEstimate = {
  rateBytesPerSec: null,
  etaMs: null,
  capped: false,
  stalled: false,
};

export class RateEstimator {
  private points: Point[] = [];
  /** Last ETA we were willing to publish; held whenever progress isn't moving. */
  private lastEtaMs: number | null = null;
  private lastEtaCapped = false;
  /** When `progressBytes` last actually moved. */
  private lastProgressAt: number | null = null;
  private lastProgressBytes = 0;

  /** Drop all history — call when a new run starts. */
  reset(): void {
    this.points = [];
    this.lastEtaMs = null;
    this.lastEtaCapped = false;
    this.lastProgressAt = null;
    this.lastProgressBytes = 0;
  }

  /**
   * Fold in one observation and return the current estimate. Callers sample on
   * a timer (~1 s); the maths does not assume a fixed interval, only that
   * `now` moves forward.
   */
  sample(input: RateSample): RateEstimate {
    const { wireBytes, progressBytes, totalBytes, startedAt, now } = input;

    const moved = this.lastProgressAt === null || progressBytes > this.lastProgressBytes;
    if (moved) {
      this.lastProgressAt = now;
      this.lastProgressBytes = progressBytes;
    }

    this.points.push({ t: now, wire: wireBytes, progress: progressBytes });
    // Keep one point older than the window so a lookback always has an anchor.
    const cutoff = now - WINDOW_MS;
    let firstKeep = 0;
    while (firstKeep + 1 < this.points.length && this.points[firstKeep + 1].t < cutoff) {
      firstKeep++;
    }
    if (firstKeep > 0) this.points = this.points.slice(firstKeep);

    const elapsed = now - startedAt;
    const rateBytesPerSec = this.windowedRate(now, SPEED_WINDOW_MS, (p) => p.wire);

    // Too early to say anything about the ETA. The speed is still reportable —
    // it stands on its own and doesn't multiply a remaining-bytes figure.
    if (totalBytes <= 0 || elapsed < MIN_ELAPSED_MS || progressBytes < MIN_BYTES) {
      return { ...EMPTY, rateBytesPerSec };
    }

    const sinceProgress = now - (this.lastProgressAt ?? now);
    if (sinceProgress >= ETA_DROP_MS) {
      this.lastEtaMs = null;
      return { rateBytesPerSec, etaMs: null, capped: false, stalled: true };
    }
    // Freeze the estimate the moment progress stops, not once the stall is
    // "official". Recomputing while nothing moves is precisely what inflated
    // the old number: every idle sample dragged the windowed rate toward zero
    // and pushed the ETA up, so a run that merely paused looked like one that
    // would never finish. STALL_MS only decides when to *say* it is stalled.
    if (!moved && this.lastEtaMs !== null) {
      return {
        rateBytesPerSec,
        etaMs: this.lastEtaMs,
        capped: this.lastEtaCapped,
        stalled: sinceProgress >= STALL_MS,
      };
    }

    const windowed = this.windowedRate(now, WINDOW_MS, (p) => p.progress) ?? 0;
    const runAverage = (progressBytes * 1000) / elapsed;
    const etaRate = Math.max(windowed, runAverage * FLOOR_FRACTION);
    if (etaRate <= 0) return { ...EMPTY, rateBytesPerSec };

    const remaining = Math.max(0, totalBytes - progressBytes);
    const raw = (remaining / etaRate) * 1000;
    this.lastEtaCapped = raw > ETA_CEILING_MS;
    this.lastEtaMs = this.lastEtaCapped ? ETA_CEILING_MS : raw;
    return {
      rateBytesPerSec,
      etaMs: this.lastEtaMs,
      capped: this.lastEtaCapped,
      stalled: false,
    };
  }

  /**
   * Mean rate in bytes/sec over the last `windowMs`, from the oldest retained
   * point at or before the window start. Null until there are two points
   * separated in time.
   */
  private windowedRate(
    now: number,
    windowMs: number,
    pick: (p: Point) => number,
  ): number | null {
    if (this.points.length < 2) return null;
    const cutoff = now - windowMs;
    // Newest point at or before the cutoff, else the oldest we have.
    let anchor = this.points[0];
    for (const p of this.points) {
      if (p.t <= cutoff) anchor = p;
      else break;
    }
    const latest = this.points[this.points.length - 1];
    const dt = latest.t - anchor.t;
    if (dt <= 0) return null;
    const delta = pick(latest) - pick(anchor);
    if (delta <= 0) return 0;
    return (delta * 1000) / dt;
  }
}

/** "~3m left" / "~45s left" / "over a day left" / "stalled". */
export function formatEta(est: RateEstimate): string {
  if (est.stalled && est.etaMs == null) return 'stalled';
  if (est.capped) return 'over a day left';
  const ms = est.etaMs;
  if (ms == null || !Number.isFinite(ms)) return '';
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `~${Math.max(1, totalSec)}s left`;
  const totalMin = Math.round(totalSec / 60);
  if (totalMin < 60) return `~${totalMin}m left`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m ? `~${h}h ${m}m left` : `~${h}h left`;
}

/** "1.2 MiB/s". `null` or zero → empty string (never a bare "0 B/s"). */
export function formatRate(bytesPerSec: number | null): string {
  if (bytesPerSec == null || bytesPerSec <= 0) return '';
  const s = bytesPerSec;
  if (s < 1024) return `${Math.round(s)} B/s`;
  if (s < 1024 * 1024) return `${(s / 1024).toFixed(0)} KiB/s`;
  return `${(s / 1024 / 1024).toFixed(1)} MiB/s`;
}
