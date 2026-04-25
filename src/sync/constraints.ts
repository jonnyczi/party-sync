import type { JobRow, SkipReason } from '../db/types';

export interface ConstraintState {
  networkType: 'wifi' | 'cellular' | 'other' | 'none';
  isDataSaverOn: boolean;
  isCharging: boolean;
}

export type ConstraintDecision =
  | { pass: true }
  | { pass: false; reason: SkipReason };

export type ConstraintInputs = Pick<
  JobRow,
  'wifi_only' | 'respect_data_saver' | 'charging_only'
>;

/**
 * Decide whether a periodic tick should run for a given job given the
 * current device state. Evaluation order fixes the reason when multiple
 * constraints fail simultaneously — pick the order that surfaces the most
 * actionable reason first (Wi-Fi off trumps Data Saver since turning on
 * Wi-Fi also gets us off a metered connection).
 */
export function evaluateConstraints(
  job: ConstraintInputs,
  state: ConstraintState,
): ConstraintDecision {
  if (job.wifi_only && state.networkType !== 'wifi') {
    return { pass: false, reason: 'wifi_only' };
  }
  if (job.respect_data_saver && state.isDataSaverOn) {
    return { pass: false, reason: 'data_saver' };
  }
  if (job.charging_only && !state.isCharging) {
    return { pass: false, reason: 'charging_only' };
  }
  return { pass: true };
}
