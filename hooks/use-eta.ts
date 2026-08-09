import { useEffect, useRef, useState } from 'react';

import { RateEstimator, type RateEstimate } from '@/src/sync/rate-estimator';

/**
 * React wrapper around {@link RateEstimator} for the active run.
 *
 * Owns nothing but the sampling timer: values are read from a ref on a 1s tick
 * (independent of how often the progress bus mutates) and handed to the
 * estimator, which does all the maths. See that module for why speed and ETA
 * come from different numerators.
 */
const SAMPLE_MS = 1000;

export type EtaEstimate = RateEstimate;

export function useEta(
  wireBytes: number,
  progressBytes: number,
  totalBytes: number,
  startedAt: number,
): EtaEstimate {
  // The timer reads the freshest values via a ref rather than closing over
  // stale props.
  const latest = useRef({ wireBytes, progressBytes, totalBytes, startedAt });
  latest.current = { wireBytes, progressBytes, totalBytes, startedAt };

  const estimatorRef = useRef<RateEstimator | null>(null);
  estimatorRef.current ??= new RateEstimator();
  const resultRef = useRef<RateEstimate>({
    rateBytesPerSec: null,
    etaMs: null,
    capped: false,
    stalled: false,
  });
  const runRef = useRef(startedAt);
  const [, force] = useState(0);

  // Reset when a new run starts (startedAt changes).
  if (runRef.current !== startedAt) {
    runRef.current = startedAt;
    estimatorRef.current.reset();
    resultRef.current = {
      rateBytesPerSec: null,
      etaMs: null,
      capped: false,
      stalled: false,
    };
  }

  useEffect(() => {
    const id = setInterval(() => {
      resultRef.current = estimatorRef.current!.sample({
        ...latest.current,
        now: Date.now(),
      });
      force((n) => (n + 1) % 1_000_000);
    }, SAMPLE_MS);
    return () => clearInterval(id);
  }, []);

  return resultRef.current;
}

// Formatters live with the estimator (src/sync/rate-estimator.ts) so the
// headless notification updater can render the same strings without pulling in
// React; re-exported here for the components that already import from this hook.
export { formatEta, formatRate } from '@/src/sync/rate-estimator';
