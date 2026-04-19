import { useSyncExternalStore } from 'react';

import { defaultProgressBus, type ProgressSnapshot } from '@/src/sync/progress';

/**
 * Subscribe to the app-wide sync progress bus. Returns the current
 * snapshot; re-renders when the bus mutates. Safe in SSR / web contexts
 * because ProgressBus mutates synchronously — no `getServerSnapshot`
 * mismatch risk.
 */
export function useSyncProgress(): ProgressSnapshot {
  return useSyncExternalStore(defaultProgressBus.subscribe, defaultProgressBus.getSnapshot);
}
