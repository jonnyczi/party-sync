import { Platform } from 'react-native';

import CopypartySync from '../../modules/copyparty-sync';

import { evaluateSyncHealth, type HealthItem } from './health-eval';

/**
 * On-device collector feeding the pure evaluator (health-eval.ts). Returns []
 * off-Android / when the native module is unavailable — callers hide the
 * checklist entirely in that case.
 *
 * Notifications used to be a row here. They are a permission, not a device
 * setting, so they moved to the App permissions screen
 * (src/permissions/permissions.ts) where the check is also correct: the
 * POST_NOTIFICATIONS grant this file used to read says nothing about the user
 * having switched the app's notifications off wholesale.
 */
export async function readSyncHealth(): Promise<HealthItem[]> {
  if (Platform.OS !== 'android' || !CopypartySync) return [];

  return evaluateSyncHealth({
    batteryExempt: CopypartySync.isIgnoringBatteryOptimizations(),
    backgroundRestricted: CopypartySync.isBackgroundRestricted(),
    dataSaver: CopypartySync.getDataSaverStatus(),
    standbyBucket: CopypartySync.getAppStandbyBucket(),
    manufacturer: CopypartySync.getManufacturer(),
  });
}

/** True when anything is outright blocked (drives the dashboard warning card). */
export function hasBlockedItem(items: HealthItem[]): boolean {
  return items.some((i) => i.status === 'blocked');
}
