import { AppRegistry, Platform } from 'react-native';

import CopypartySync from '../../modules/copyparty-sync';

/**
 * RN suspends the JS world (timers, task dispatch) once the last Activity is
 * destroyed — a foreground service keeps the *process* alive but not JS:
 * verified on-device, an in-flight upload froze at swipe-away and resumed only
 * on relaunch. An active headless task is RN's signal that background JS work
 * is running; while one exists, JS keeps executing with no Activity.
 *
 * acquire/release bracket a sync run (see withForegroundService). The
 * registered task's promise resolves on release — RN then reports the task
 * finished to native on its own.
 */

/** Must match KEEPALIVE_TASK in CopypartySyncModule.kt. */
const TASK_NAME = 'copyparty-keepalive';

let refs = 0;
let releaseCurrent: (() => void) | null = null;

if (Platform.OS === 'android') {
  // Module-load registration: AppRegistry must know the task before native
  // startTask fires it. This module is imported by foreground.ts, which loads
  // with the sync engine at app startup.
  AppRegistry.registerHeadlessTask(TASK_NAME, () => async () => {
    if (refs === 0) return; // released (or errored) before the task spun up
    await new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
  });
}

export async function acquireKeepAlive(): Promise<void> {
  if (Platform.OS !== 'android' || !CopypartySync) return;
  refs++;
  if (refs > 1) return;
  try {
    await CopypartySync.startKeepAlive();
  } catch (e) {
    // Non-fatal: the run proceeds; it just won't survive losing the Activity.
    console.warn('[copyparty] keep-alive start failed', e);
    refs--;
  }
}

export function releaseKeepAlive(): void {
  if (Platform.OS !== 'android' || !CopypartySync) return;
  if (refs === 0) return;
  refs--;
  if (refs === 0) {
    releaseCurrent?.();
    releaseCurrent = null;
  }
}
