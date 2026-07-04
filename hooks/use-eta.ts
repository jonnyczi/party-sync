import { useEffect, useRef, useState } from 'react';

/**
 * Smoothed upload-rate + ETA estimator for the active run.
 *
 * The overall byte total is sampled on a 1s timer (independent of how often
 * the progress bus mutates) and folded into an exponential moving average, so
 * the rate reacts to the connection speeding up / slowing down without the
 * jumpiness of an instantaneous reading. The ETA is suppressed early in the
 * run — before there is enough elapsed time and progress to be meaningful —
 * so the user never sees a wild "4 days left" flash on the first sample.
 */
const SAMPLE_MS = 1000;
// Weight of the newest sample. Lower = smoother but slower to react.
const EMA_ALPHA = 0.3;
// Don't show an ETA until the run has this much history + progress behind it.
const MIN_ELAPSED_MS = 4000;
const MIN_BYTES = 256 * 1024;

export interface EtaEstimate {
  /** Smoothed throughput in bytes/sec, or null before the first sample. */
  rateBytesPerSec: number | null;
  /** Estimated milliseconds remaining, or null while suppressed. */
  etaMs: number | null;
}

export function useEta(
  uploadedBytes: number,
  totalBytes: number,
  startedAt: number,
): EtaEstimate {
  // The timer reads the freshest values via a ref rather than closing over
  // stale props.
  const latest = useRef({ uploadedBytes, totalBytes, startedAt });
  latest.current = { uploadedBytes, totalBytes, startedAt };

  const emaRef = useRef<number | null>(null);
  const prevRef = useRef<{ bytes: number; t: number } | null>(null);
  const runRef = useRef(startedAt);
  const [, force] = useState(0);

  // Reset the EMA when a new run starts (startedAt changes).
  if (runRef.current !== startedAt) {
    runRef.current = startedAt;
    emaRef.current = null;
    prevRef.current = null;
  }

  useEffect(() => {
    const id = setInterval(() => {
      const { bytes: pb, t: pt } = prevRef.current ?? { bytes: 0, t: 0 };
      const b = latest.current.uploadedBytes;
      const t = Date.now();
      if (prevRef.current && t > pt) {
        const inst = ((b - pb) * 1000) / (t - pt); // bytes/sec
        if (inst >= 0) {
          emaRef.current =
            emaRef.current == null
              ? inst
              : EMA_ALPHA * inst + (1 - EMA_ALPHA) * emaRef.current;
        }
      }
      prevRef.current = { bytes: b, t };
      force((n) => (n + 1) % 1_000_000);
    }, SAMPLE_MS);
    return () => clearInterval(id);
  }, []);

  const rate = emaRef.current;
  const elapsed = Date.now() - startedAt;
  if (
    rate == null ||
    rate <= 0 ||
    totalBytes <= 0 ||
    elapsed < MIN_ELAPSED_MS ||
    uploadedBytes < MIN_BYTES
  ) {
    return { rateBytesPerSec: rate, etaMs: null };
  }
  const remaining = Math.max(0, totalBytes - uploadedBytes);
  return { rateBytesPerSec: rate, etaMs: (remaining / rate) * 1000 };
}

/** "~3m left" / "~45s left" / "~1h 20m left". `null` → empty string. */
export function formatEta(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return '';
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `~${Math.max(1, totalSec)}s left`;
  const totalMin = Math.round(totalSec / 60);
  if (totalMin < 60) return `~${totalMin}m left`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m ? `~${h}h ${m}m left` : `~${h}h left`;
}

/** "1.2 MiB/s". `null` → empty string. */
export function formatRate(bytesPerSec: number | null): string {
  if (bytesPerSec == null || bytesPerSec <= 0) return '';
  const s = bytesPerSec;
  if (s < 1024) return `${Math.round(s)} B/s`;
  if (s < 1024 * 1024) return `${(s / 1024).toFixed(0)} KiB/s`;
  return `${(s / 1024 / 1024).toFixed(1)} MiB/s`;
}
