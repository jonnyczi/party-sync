import { Platform } from 'react-native';

import CopypartyNotify from '../../modules/copyparty-notify';

const CHANNEL_ID = 'copyparty-sync';
// NotificationManagerCompat keys notifications by integer id; one fixed slot for
// the single "sync active" notification we ever post.
const NOTIF_ID = 1;

let channelReady = false;

/**
 * Idempotent channel setup. Android requires a channel before a notification
 * can be posted. iOS/web have no native module (it's Android-only) so the
 * import resolves to null and every call here no-ops. Importance LOW — we want
 * the notification visible (so Android treats the app as foregrounded during a
 * WorkManager-triggered run) but silent and unobtrusive.
 *
 * Notifications go through `modules/copyparty-notify` (androidx.core only)
 * rather than `expo-notifications`, whose Android build pulls in Firebase
 * Cloud Messaging — a hard F-Droid blocker we don't need for local-only
 * notifications.
 */
async function ensureChannel(): Promise<void> {
  if (Platform.OS !== 'android' || channelReady || !CopypartyNotify) return;
  await CopypartyNotify.setChannel(CHANNEL_ID, 'Sync in progress', 'low');
  channelReady = true;
}

async function showSyncNotification(jobName: string): Promise<void> {
  if (Platform.OS !== 'android' || !CopypartyNotify) return;
  await ensureChannel();
  // `ongoing` keeps it sticky for the duration of the run.
  await CopypartyNotify.notify(CHANNEL_ID, NOTIF_ID, 'copyparty', `Syncing: ${jobName}`, true);
}

async function dismissSyncNotification(): Promise<void> {
  if (Platform.OS !== 'android' || !CopypartyNotify) return;
  try {
    await CopypartyNotify.dismiss(NOTIF_ID);
  } catch {
    // Best-effort. If the platform can't dismiss (e.g. notification was never
    // posted because permission was denied), move on — the next run will
    // overwrite the sticky anyway.
  }
}

/**
 * Run `fn` with a persistent "Syncing…" notification posted for its duration.
 * The ongoing notification is what keeps the app process alive under Doze /
 * WorkManager and is also the user-visible affordance during manual runs.
 * Notification clears in `finally` — caller doesn't need to handle it.
 *
 * Failures to post/dismiss are swallowed; the sync itself must not fail because
 * a notification couldn't be shown (user may have denied POST_NOTIFICATIONS).
 * We log and keep going.
 */
export async function withForegroundService<T>(
  jobName: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    await showSyncNotification(jobName);
  } catch (e) {
    console.warn('[copyparty] foreground notification post failed', e);
  }
  try {
    return await fn();
  } finally {
    await dismissSyncNotification();
  }
}
