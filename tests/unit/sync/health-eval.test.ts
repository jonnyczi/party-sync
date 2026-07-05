import { describe, expect, it } from 'vitest';

import {
  AGGRESSIVE_OEMS,
  evaluateSyncHealth,
  type HealthProbeState,
} from '../../../src/sync/health-eval';

const healthy: HealthProbeState = {
  notificationsGranted: true,
  batteryExempt: true,
  backgroundRestricted: false,
  dataSaver: 'disabled',
  standbyBucket: 'active',
  manufacturer: 'google',
};

function itemById(state: HealthProbeState) {
  return new Map(evaluateSyncHealth(state).map((i) => [i.id, i]));
}

describe('evaluateSyncHealth', () => {
  it('returns all six items, every one ok, on a healthy device', () => {
    const items = evaluateSyncHealth(healthy);
    expect(items.map((i) => i.id)).toEqual([
      'battery',
      'background_restriction',
      'notifications',
      'data_saver',
      'standby',
      'oem',
    ]);
    expect(items.every((i) => i.status === 'ok')).toBe(true);
    expect(items.every((i) => i.fix === undefined)).toBe(true);
  });

  it('flags missing battery exemption as blocked with the direct dialog fix', () => {
    const item = itemById({ ...healthy, batteryExempt: false }).get('battery')!;
    expect(item.status).toBe('blocked');
    expect(item.fix).toBe('battery_dialog');
  });

  it('flags background restriction as blocked pointing at app settings', () => {
    const item = itemById({ ...healthy, backgroundRestricted: true }).get(
      'background_restriction',
    )!;
    expect(item.status).toBe('blocked');
    expect(item.fix).toBe('app_settings');
  });

  it('flags denied notifications as warn (sync still runs)', () => {
    const item = itemById({ ...healthy, notificationsGranted: false }).get(
      'notifications',
    )!;
    expect(item.status).toBe('warn');
    expect(item.fix).toBe('notification_settings');
  });

  it('warns on active Data Saver but not when whitelisted', () => {
    expect(itemById({ ...healthy, dataSaver: 'enabled' }).get('data_saver'))
      .toMatchObject({ status: 'warn', fix: 'data_saver_settings' });
    expect(
      itemById({ ...healthy, dataSaver: 'whitelisted' }).get('data_saver'),
    ).toMatchObject({ status: 'ok' });
  });

  it.each(['rare', 'restricted'])('warns on the %s standby bucket', (bucket) => {
    const item = itemById({ ...healthy, standbyBucket: bucket }).get('standby')!;
    expect(item.status).toBe('warn');
    expect(item.detail).toContain(bucket);
  });

  it.each(['active', 'working_set', 'frequent', 'unknown'])(
    'does not warn on the %s standby bucket',
    (bucket) => {
      expect(itemById({ ...healthy, standbyBucket: bucket }).get('standby'))
        .toMatchObject({ status: 'ok' });
    },
  );

  it.each(Object.keys(AGGRESSIVE_OEMS))(
    'warns with a dontkillmyapp link on %s devices',
    (vendor) => {
      const item = itemById({ ...healthy, manufacturer: vendor }).get('oem')!;
      expect(item.status).toBe('warn');
      expect(item.fix).toBe('web_guide');
      expect(item.url).toBe(`https://dontkillmyapp.com/${AGGRESSIVE_OEMS[vendor]}`);
    },
  );

  it('leaves unknown manufacturers ok', () => {
    expect(itemById({ ...healthy, manufacturer: 'fairphone' }).get('oem'))
      .toMatchObject({ status: 'ok' });
  });

  it('reports multiple simultaneous problems independently', () => {
    const items = evaluateSyncHealth({
      notificationsGranted: false,
      batteryExempt: false,
      backgroundRestricted: true,
      dataSaver: 'enabled',
      standbyBucket: 'restricted',
      manufacturer: 'samsung',
    });
    expect(items.filter((i) => i.status === 'blocked')).toHaveLength(2);
    expect(items.filter((i) => i.status === 'warn')).toHaveLength(4);
  });
});
