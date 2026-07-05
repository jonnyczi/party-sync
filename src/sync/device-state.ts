import * as Battery from 'expo-battery';
import * as Network from 'expo-network';

import CopypartySync from '../../modules/copyparty-sync';

import type { ConstraintState } from './constraints';

/**
 * Live device-state probe for the constraint gate. Wired from the
 * periodic trigger; pure TS would make `constraints.ts` untestable against
 * node (no native modules), so the split keeps `evaluateConstraints` unit-
 * testable and this module the single integration surface.
 *
 * Data Saver comes from `ConnectivityManager.getRestrictBackgroundStatus()`
 * via modules/copyparty-sync. Only the 'enabled' state gates syncing —
 * 'whitelisted' means the user explicitly allowed this app unrestricted data,
 * so `respect_data_saver` jobs may proceed.
 */
export async function readConstraintState(): Promise<ConstraintState> {
  const [netState, batteryState] = await Promise.all([
    Network.getNetworkStateAsync(),
    Battery.getBatteryStateAsync(),
  ]);

  const networkType = mapNetworkType(netState.type, netState.isConnected);
  const isCharging =
    batteryState === Battery.BatteryState.CHARGING ||
    batteryState === Battery.BatteryState.FULL;

  return {
    networkType,
    isDataSaverOn: CopypartySync?.getDataSaverStatus() === 'enabled',
    isCharging,
  };
}

function mapNetworkType(
  type: Network.NetworkStateType | undefined,
  isConnected: boolean | undefined,
): ConstraintState['networkType'] {
  if (!isConnected) return 'none';
  switch (type) {
    case Network.NetworkStateType.WIFI:
      return 'wifi';
    case Network.NetworkStateType.CELLULAR:
      return 'cellular';
    case Network.NetworkStateType.NONE:
    case Network.NetworkStateType.UNKNOWN:
    case undefined:
      return 'none';
    default:
      return 'other';
  }
}
