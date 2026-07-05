/**
 * Pure evaluation of background-sync health — no native imports so it stays
 * unit-testable under node (same split rationale as constraints.ts vs
 * device-state.ts). `src/sync/health.ts` gathers the probe inputs on-device.
 */

export type HealthStatus = 'ok' | 'warn' | 'blocked';

/** Which Fix action a checklist row's button dispatches (src/sync/health-fixes). */
export type HealthFix =
  | 'battery_dialog'
  | 'notification_settings'
  | 'app_settings'
  | 'data_saver_settings'
  | 'web_guide';

export type DataSaverStatus = 'disabled' | 'whitelisted' | 'enabled';

export interface HealthProbeState {
  notificationsGranted: boolean;
  batteryExempt: boolean;
  backgroundRestricted: boolean;
  dataSaver: DataSaverStatus;
  standbyBucket: string;
  manufacturer: string;
}

export interface HealthItem {
  id: 'battery' | 'background_restriction' | 'notifications' | 'data_saver' | 'standby' | 'oem';
  status: HealthStatus;
  title: string;
  detail: string;
  fix?: HealthFix;
  /** Set for fix === 'web_guide': the dontkillmyapp.com vendor page. */
  url?: string;
}

/** Vendors with documented aggressive app killing → dontkillmyapp.com slug. */
export const AGGRESSIVE_OEMS: Record<string, string> = {
  xiaomi: 'xiaomi',
  huawei: 'huawei',
  oppo: 'oppo',
  vivo: 'vivo',
  oneplus: 'oneplus',
  samsung: 'samsung',
  meizu: 'meizu',
};

/**
 * Ordered by impact: blocked-capable items first. Every item is always
 * returned (with status 'ok' when healthy) so the checklist renders green
 * checks, not an empty screen.
 */
export function evaluateSyncHealth(p: HealthProbeState): HealthItem[] {
  const items: HealthItem[] = [];

  items.push(
    p.batteryExempt
      ? {
          id: 'battery',
          status: 'ok',
          title: 'Battery optimization',
          detail: 'Exempt — scheduled sync can run while the app is closed.',
        }
      : {
          id: 'battery',
          status: 'blocked',
          title: 'Battery optimization',
          detail:
            'Android blocks scheduled sync from starting while the app is closed, and pauses transfers when the screen is off. Allow the exemption so syncs run reliably in the background.',
          fix: 'battery_dialog',
        },
  );

  items.push(
    p.backgroundRestricted
      ? {
          id: 'background_restriction',
          status: 'blocked',
          title: 'Background usage',
          detail:
            "Background activity is set to 'Restricted' for this app — scheduled sync will not run at all. Remove the restriction under App info → Battery.",
          fix: 'app_settings',
        }
      : {
          id: 'background_restriction',
          status: 'ok',
          title: 'Background usage',
          detail: 'Background activity is allowed.',
        },
  );

  items.push(
    p.notificationsGranted
      ? {
          id: 'notifications',
          status: 'ok',
          title: 'Notifications',
          detail: 'Sync progress and results will be visible.',
        }
      : {
          id: 'notifications',
          status: 'warn',
          title: 'Notifications',
          detail:
            'Notifications are off — syncs still run, but progress and failures are invisible.',
          fix: 'notification_settings',
        },
  );

  items.push(
    p.dataSaver === 'enabled'
      ? {
          id: 'data_saver',
          status: 'warn',
          title: 'Data Saver',
          detail:
            'Data Saver is on. Jobs that respect it will skip syncing on mobile data; allow unrestricted data for this app to sync anyway.',
          fix: 'data_saver_settings',
        }
      : {
          id: 'data_saver',
          status: 'ok',
          title: 'Data Saver',
          detail:
            p.dataSaver === 'whitelisted'
              ? 'Data Saver is on, but this app is allowed unrestricted data.'
              : 'Data Saver is off.',
        },
  );

  const sleepyBucket = p.standbyBucket === 'rare' || p.standbyBucket === 'restricted';
  items.push(
    sleepyBucket
      ? {
          id: 'standby',
          status: 'warn',
          title: 'App standby',
          detail: `Android put this app in its '${p.standbyBucket}' standby bucket — scheduled syncs may be delayed by hours. Opening the app regularly raises the bucket.`,
        }
      : {
          id: 'standby',
          status: 'ok',
          title: 'App standby',
          detail: 'Scheduled jobs are not standby-throttled.',
        },
  );

  const oemSlug = AGGRESSIVE_OEMS[p.manufacturer];
  items.push(
    oemSlug
      ? {
          id: 'oem',
          status: 'warn',
          title: 'Device-specific settings',
          detail: `${capitalize(p.manufacturer)} devices are known to kill background apps beyond standard Android rules. Review the community guide for extra steps.`,
          fix: 'web_guide',
          url: `https://dontkillmyapp.com/${oemSlug}`,
        }
      : {
          id: 'oem',
          status: 'ok',
          title: 'Device-specific settings',
          detail: 'No known vendor-specific background restrictions.',
        },
  );

  return items;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
