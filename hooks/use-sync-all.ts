import { useSyncExternalStore } from 'react';

import {
  defaultSyncAllBus,
  type SyncAllSnapshot,
} from '@/src/sync/triggers/sync-all';

/**
 * Subscribe to the Sync All batch state. `snapshot.batch` is null unless a
 * sync-all batch is in flight; per-run progress still comes from
 * `useSyncProgress`.
 */
export function useSyncAll(): SyncAllSnapshot {
  return useSyncExternalStore(defaultSyncAllBus.subscribe, defaultSyncAllBus.getSnapshot);
}
