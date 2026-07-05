import { NativeModule, requireOptionalNativeModule } from 'expo';

declare class CopypartySyncModule extends NativeModule {
  /** Start the dataSync foreground service (ongoing notification + partial
   *  wake lock) for the duration of a sync run. Resolves `true` when the
   *  service is up; `false` when Android refused the start (background-started
   *  process without an exemption on API 31+) — callers should fall back to a
   *  plain notification. */
  startForegroundSync(title: string, text: string): Promise<boolean>;

  /** Stop the foreground service; its notification is removed with it.
   *  Idempotent — stopping a non-running service is a no-op. */
  stopForegroundSync(): Promise<void>;

  /** Start the RN headless keep-alive task (key `copyparty-keepalive`, must be
   *  registered via AppRegistry first — see src/sync/keep-alive.ts). While
   *  active, RN keeps the JS world running with no Activity; the task ends
   *  when the JS task promise resolves. Resolves to RN's task id. */
  startKeepAlive(): Promise<number>;

  /** Schedule the periodic tick: registers `taskName` (already defined via
   *  TaskManager.defineTask) with our freezer-safe WorkManager worker, firing
   *  every `intervalMinutes` (min 15). Idempotent across app launches. */
  registerPeriodicTask(taskName: string, intervalMinutes: number): Promise<void>;

  /** Unregister the periodic tick and cancel its scheduled work. */
  unregisterPeriodicTask(taskName: string): Promise<void>;

  /** Liveness handshake: the JS periodic-task body calls this first so the
   *  native worker knows the headless JS world came up (its watchdog retries
   *  in a fresh process otherwise). */
  markTickAlive(): Promise<void>;

  // ---- Health probes (synchronous) ----

  /** Battery-optimization exemption: the setting that lets scheduled sync
   *  start a foreground service from the background and survive Doze. */
  isIgnoringBatteryOptimizations(): boolean;

  /** True when the user chose "Restricted" battery use — WorkManager jobs
   *  stop entirely. */
  isBackgroundRestricted(): boolean;

  /** Data Saver: 'enabled' restricts background data on metered networks
   *  ('whitelisted' = this app exempted, 'disabled' = Data Saver off). */
  getDataSaverStatus(): 'disabled' | 'whitelisted' | 'enabled';

  /** Standby bucket; 'rare'/'restricted' delays scheduled jobs substantially.
   *  'unknown' below API 28. */
  getAppStandbyBucket(): 'active' | 'working_set' | 'frequent' | 'rare' | 'restricted' | 'unknown';

  /** Build.MANUFACTURER, lowercased (e.g. 'samsung', 'xiaomi'). */
  getManufacturer(): string;

  // ---- Settings shortcuts ----

  /** System Allow/Deny dialog for the battery-optimization exemption. */
  requestIgnoreBatteryOptimizations(): Promise<void>;

  /** This app's notification settings page. */
  openNotificationSettings(): Promise<void>;

  /** This app's "unrestricted data" (Data Saver) settings page. */
  openDataSaverSettings(): Promise<void>;

  /** This app's App-info page (battery restriction lives here). */
  openAppSettings(): Promise<void>;
}

// Optional: returns null on iOS/web (this module is Android-only). Callers
// must null-check.
export default requireOptionalNativeModule<CopypartySyncModule>('CopypartySync');
