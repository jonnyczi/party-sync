import { NativeModule, requireOptionalNativeModule } from 'expo';

declare class CopypartySyncModule extends NativeModule {
  /** Start the dataSync foreground service (ongoing notification + partial
   *  wake lock) for the duration of a sync run. Resolves `true` when the
   *  service is up; `false` when Android refused the start (background-started
   *  process without an exemption on API 31+) — callers should fall back to a
   *  plain notification. */
  startForegroundSync(title: string, text: string): Promise<boolean>;

  /** Refresh the running service's notification text (live speed / ETA) in
   *  place. Re-posting the same notification id is the sanctioned way to update
   *  a foreground-service notification — the dataSync type binding lives on the
   *  service, not the notification.
   *
   *  Added after the original start/stop pair, so — like
   *  `areNotificationsEnabled` — a binary predating it leaves the property
   *  undefined and a JS-only reload will not pick it up. Call it as
   *  `CopypartySync?.updateForegroundSync?.(…)`. */
  updateForegroundSync(title: string, text: string): Promise<void>;

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

  /** Whether Android will actually display notifications this app posts.
   *
   *  Strictly stronger than a POST_NOTIFICATIONS check: the user can switch the
   *  app's notifications off wholesale in system settings, which leaves the
   *  runtime permission reading as granted while everything posted is dropped.
   *  Below API 33 there is no runtime permission, so this is the only signal.
   *
   *  Added after the other probes, so a binary predating it leaves the property
   *  undefined — a JS reload does not pick up a new native Function. Call it as
   *  `CopypartySync?.areNotificationsEnabled?.() ?? true` so a stale build
   *  degrades to "looks fine" instead of throwing. */
  areNotificationsEnabled(): boolean;

  /** Whether the screen is on — i.e. whether the phone is plausibly in use.
   *
   *  Polled by the bandwidth limiter, which only throttles while the device is
   *  being used. AppState can't answer this: a background sync always reports
   *  'background', so "screen off" and "user is in Chrome" look identical.
   *
   *  Added after the original probes, so call it as
   *  `CopypartySync?.isScreenInteractive?.()` — a binary predating it leaves the
   *  property undefined and a JS-only reload will not pick it up. */
  isScreenInteractive(): boolean;

  /** Data Saver: 'enabled' restricts background data on metered networks
   *  ('whitelisted' = this app exempted, 'disabled' = Data Saver off). */
  getDataSaverStatus(): 'disabled' | 'whitelisted' | 'enabled';

  /** Standby bucket; 'rare'/'restricted' delays scheduled jobs substantially.
   *  'unknown' below API 28. */
  getAppStandbyBucket(): 'active' | 'working_set' | 'frequent' | 'rare' | 'restricted' | 'unknown';

  /** Build.MANUFACTURER, lowercased (e.g. 'samsung', 'xiaomi'). */
  getManufacturer(): string;

  // ---- Storage probes ----

  /** Whether a persisted SAF tree grant is still usable — one row from the
   *  tree's own document, instead of enumerating every child.
   *
   *  Resolves `true` / `false`, or **`null`** when the storage provider did not
   *  answer within `timeoutMs`. `null` is deliberately not `false`: telling a
   *  user their folder is gone when it is merely slow invites a re-pick, and a
   *  *different* pick silently repoints the job — file_state keys on
   *  tree-relative paths, so it would re-upload everything.
   *
   *  Added after the original probe set, so a binary predating it leaves the
   *  property undefined and a JS-only reload will not pick it up. Call it as
   *  `CopypartySync?.canReadFolder?.(uri, ms)` and fall back to the
   *  expo-file-system enumeration when the result is `undefined`
   *  (src/storage/saf.ts). */
  canReadFolder(treeUri: string, timeoutMs: number): Promise<boolean | null>;

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
