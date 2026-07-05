import { PermissionsAndroid, Platform } from 'react-native';

import CopypartySync from '../../modules/copyparty-sync';

import { evaluateSyncHealth, type HealthItem } from './health-eval';

/**
 * On-device collector feeding the pure evaluator (health-eval.ts). Returns []
 * off-Android / when the native module is unavailable — callers hide the
 * checklist entirely in that case.
 */
export async function readSyncHealth(): Promise<HealthItem[]> {
  if (Platform.OS !== 'android' || !CopypartySync) return [];

  // POST_NOTIFICATIONS is only a runtime permission on API 33+ (mirrors
  // notify-permission.ts).
  const notificationsGranted =
    typeof Platform.Version === 'number' && Platform.Version < 33
      ? true
      : await PermissionsAndroid.check(
          PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
        );

  return evaluateSyncHealth({
    notificationsGranted,
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
