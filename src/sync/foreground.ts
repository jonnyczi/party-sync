import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

const CHANNEL_ID = 'copyparty-sync';
const NOTIF_ID = 'copyparty-sync-active';

let channelReady = false;

/**
 * Idempotent channel setup. Android requires a channel before a
 * notification can be posted; iOS ignores it. Importance LOW — we want
 * the notification visible (so Android treats the app as foregrounded
 * during a WorkManager-triggered run) but not loud.
 */
async function ensureChannel(): Promise<void> {
  if (Platform.OS !== 'android' || channelReady) return;
  await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
    name: 'Sync in progress',
    importance: Notifications.AndroidImportance.LOW,
    sound: null,
    vibrationPattern: null,
    showBadge: false,
  });
  channelReady = true;
}

async function showSyncNotification(jobName: string): Promise<void> {
  await ensureChannel();
  await Notifications.scheduleNotificationAsync({
    identifier: NOTIF_ID,
    content: {
      title: 'copyparty',
      body: `Syncing: ${jobName}`,
      sticky: true,
      priority: Notifications.AndroidNotificationPriority.LOW,
    },
    // Channel-aware trigger delivers immediately AND routes to the LOW
    // importance channel on Android. iOS has no channels and accepts null.
    trigger: Platform.OS === 'android' ? { channelId: CHANNEL_ID } : null,
  });
}

async function dismissSyncNotification(): Promise<void> {
  try {
    await Notifications.dismissNotificationAsync(NOTIF_ID);
  } catch {
    // Best-effort. If the platform can't dismiss (e.g. notification was
    // never posted because permission was denied), move on — the next
    // run will overwrite the sticky anyway.
  }
}

/**
 * Run `fn` with a persistent "Syncing…" notification posted for its
 * duration. The ongoing notification is what keeps the app process alive
 * under Doze / WorkManager and is also the user-visible affordance during
 * manual runs. Notification clears in `finally` — caller doesn't need to
 * handle it.
 *
 * Failures to post/dismiss are swallowed; the sync itself must not fail
 * because a notification couldn't be shown (user may have denied
 * POST_NOTIFICATIONS). We log and keep going.
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
