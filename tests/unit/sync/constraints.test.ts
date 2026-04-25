import { describe, expect, it } from 'vitest';

import {
  type ConstraintInputs,
  type ConstraintState,
  evaluateConstraints,
} from '@/src/sync/constraints';

const allOn: ConstraintInputs = {
  wifi_only: 1,
  respect_data_saver: 1,
  charging_only: 1,
};
const allOff: ConstraintInputs = {
  wifi_only: 0,
  respect_data_saver: 0,
  charging_only: 0,
};
const idealState: ConstraintState = {
  networkType: 'wifi',
  isDataSaverOn: false,
  isCharging: true,
};

describe('evaluateConstraints', () => {
  it('passes when all conditions are met', () => {
    expect(evaluateConstraints(allOn, idealState)).toEqual({ pass: true });
  });

  it('passes trivially when no constraints are enabled', () => {
    expect(
      evaluateConstraints(allOff, {
        networkType: 'none',
        isDataSaverOn: true,
        isCharging: false,
      }),
    ).toEqual({ pass: true });
  });

  it('fails wifi_only when on cellular', () => {
    expect(
      evaluateConstraints(
        { ...allOff, wifi_only: 1 },
        { ...idealState, networkType: 'cellular' },
      ),
    ).toEqual({ pass: false, reason: 'wifi_only' });
  });

  it('fails wifi_only when offline', () => {
    expect(
      evaluateConstraints(
        { ...allOff, wifi_only: 1 },
        { ...idealState, networkType: 'none' },
      ),
    ).toEqual({ pass: false, reason: 'wifi_only' });
  });

  it('fails data_saver when OS restrict-background is on', () => {
    expect(
      evaluateConstraints(
        { ...allOff, respect_data_saver: 1 },
        { ...idealState, isDataSaverOn: true },
      ),
    ).toEqual({ pass: false, reason: 'data_saver' });
  });

  it('fails charging_only when not charging', () => {
    expect(
      evaluateConstraints(
        { ...allOff, charging_only: 1 },
        { ...idealState, isCharging: false },
      ),
    ).toEqual({ pass: false, reason: 'charging_only' });
  });

  it('reports wifi_only ahead of data_saver when both would fail', () => {
    // Cellular + data saver on — both trigger. Wi-Fi fix resolves both,
    // so surface the more actionable reason first.
    expect(
      evaluateConstraints(allOn, {
        networkType: 'cellular',
        isDataSaverOn: true,
        isCharging: true,
      }),
    ).toEqual({ pass: false, reason: 'wifi_only' });
  });

  it('reports data_saver ahead of charging_only', () => {
    expect(
      evaluateConstraints(allOn, {
        networkType: 'wifi',
        isDataSaverOn: true,
        isCharging: false,
      }),
    ).toEqual({ pass: false, reason: 'data_saver' });
  });
});
