import { Platform } from 'react-native';

import CopypartyNotify from '../../modules/copyparty-notify';
import CopypartySync from '../../modules/copyparty-sync';

import { APP_NAME } from '../app-name';

import { acquireKeepAlive, releaseKeepAlive } from './keep-alive';
import type { ProgressBus } from './progress';
import { RateEstimator, formatEta, formatRate } from './rate-estimator';

// Channel id is a persisted identifier — renaming it would orphan the user's
// existing notification settings, so it stays `copyparty-sync` regardless of
// what the app is called.
const CHANNEL_ID = 'copyparty-sync';
// NotificationManagerCompat keys notifications by integer id; one fixed slot for
// the single "sync active" notification we ever post.
const NOTIF_ID = 1;

let channelReady = false;

/**
 * Idempotent channel setup. Android requires a channel before a notification
 * can be posted. iOS/web have no native module (it's Android-only) so the
 * import resolves to null and every call here no-ops. Importance LOW — the
 * notification should be visible but silent and unobtrusive.
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
  // `ongoing` keeps it sticky for the duration of the run; null deep link — the
  // sync notification isn't tappable (result notifications are, see notify-result).
  await CopypartyNotify.notify(
    CHANNEL_ID,
    NOTIF_ID,
    APP_NAME,
    `Syncing: ${jobName}`,
    true,
    null,
  );
}

// How often the progress bus is sampled, and the floor on how often the
// notification is actually re-posted. Android drops same-id updates past a few
// per second, and each post is a binder round-trip, so sample at the
// estimator's natural cadence but publish at half that.
const NOTIF_SAMPLE_MS = 1000;
const NOTIF_UPDATE_MS = 2000;

/**
 * "Syncing: Camera roll · 42% · 4.1 MiB/s · ~11m left", dropping whatever
 * isn't available yet. Returns null while there is no active run to describe.
 */
function progressText(
  jobName: string,
  bus: ProgressBus,
  estimator: RateEstimator,
  now: number,
): string | null {
  const run = bus.getSnapshot().activeRun;
  if (!run) return null;
  const est = estimator.sample({
    wireBytes: run.wireBytes,
    progressBytes: run.uploadedBytes,
    totalBytes: run.totalBytes,
    startedAt: run.startedAt,
    now,
  });
  const pct =
    run.totalBytes > 0
      ? `${Math.min(100, Math.round((run.uploadedBytes / run.totalBytes) * 100))}%`
      : '';
  const parts = [pct, formatRate(est.rateBytesPerSec), formatEta(est)].filter(Boolean);
  return [`Syncing: ${jobName}`, ...parts].join(' · ');
}

/**
 * Drive the ongoing notification's text from the live progress bus for as long
 * as the run lasts. Returns a stop function for the caller's `finally`.
 *
 * Routes to whichever notification path owns the slot: the foreground service's
 * own updater when it started, otherwise the plain `copyparty-notify` post that
 * `showSyncNotification` used — both write NOTIF_ID on the same channel, so the
 * user sees one notification either way.
 */
function startNotificationUpdates(
  jobName: string,
  bus: ProgressBus,
  serviceStarted: boolean,
): () => void {
  if (Platform.OS !== 'android') return () => {};
  const estimator = new RateEstimator();
  let lastText: string | null = null;
  let lastPostAt = 0;
  let posting = false;

  const id = setInterval(() => {
    const now = Date.now();
    const text = progressText(jobName, bus, estimator, now);
    // Unchanged text is not worth a binder round-trip; `posting` keeps a slow
    // post from queueing up behind itself.
    if (!text || text === lastText || posting) return;
    if (now - lastPostAt < NOTIF_UPDATE_MS) return;
    lastText = text;
    lastPostAt = now;
    posting = true;
    const post = serviceStarted
      ? // Optional-call: a JS reload against a binary predating this native
        // function leaves the property undefined (see CopypartySyncModule.ts).
        CopypartySync?.updateForegroundSync?.(APP_NAME, text)
      : CopypartyNotify?.notify(CHANNEL_ID, NOTIF_ID, APP_NAME, text, true, null);
    Promise.resolve(post)
      .catch(() => {
        // Best-effort, exactly like the initial post: a notification must never
        // fail a sync.
      })
      .finally(() => {
        posting = false;
      });
  }, NOTIF_SAMPLE_MS);

  return () => clearInterval(id);
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
 * Run `fn` under a real dataSync foreground service (ongoing notification +
 * partial wake lock, via modules/copyparty-sync) plus an RN headless
 * keep-alive task. The service keeps the *process* alive through swipe-away
 * and the CPU awake with the screen off; the keep-alive task keeps the *JS
 * world* executing once the last Activity is gone (RN suspends it otherwise —
 * verified: uploads froze at swipe with the service running). Both are torn
 * down in `finally` — caller doesn't need to handle them.
 *
 * When the service can't start (Android refused a background start without an
 * exemption, or the module is unavailable off-Android) we fall back to the old
 * plain ongoing notification: the run still executes best-effort, exactly as
 * before. Failures on the notification path are swallowed too — the sync
 * itself must not fail because a notification couldn't be shown (user may have
 * denied POST_NOTIFICATIONS). We log and keep going.
 *
 * Pass `progress` to have the notification's text follow the run live (percent,
 * speed, ETA); omit it and the text stays at the initial "Syncing: <job>".
 */
export async function withForegroundService<T>(
  jobName: string,
  fn: () => Promise<T>,
  progress?: ProgressBus,
): Promise<T> {
  let serviceStarted = false;
  try {
    if (Platform.OS === 'android' && CopypartySync) {
      serviceStarted = await CopypartySync.startForegroundSync(
        APP_NAME,
        `Syncing: ${jobName}`,
      );
    }
    if (!serviceStarted) {
      await showSyncNotification(jobName);
    }
  } catch (e) {
    console.warn('[copyparty] foreground start failed', e);
  }
  // Even without the service (start refused / fallback path) the keep-alive
  // still helps for as long as the process survives.
  await acquireKeepAlive();
  const stopUpdates = progress
    ? startNotificationUpdates(jobName, progress, serviceStarted)
    : () => {};
  try {
    return await fn();
  } finally {
    stopUpdates();
    releaseKeepAlive();
    if (serviceStarted) {
      try {
        await CopypartySync!.stopForegroundSync();
      } catch (e) {
        console.warn('[copyparty] foreground service stop failed', e);
      }
    }
    // Covers the fallback path; also harmlessly re-clears the service's slot
    // (same NOTIF_ID) when the service owned the notification.
    await dismissSyncNotification();
  }
}

/**
 * Startup cleanup for state a killed process left behind: a stale "Syncing…"
 * notification and/or an orphaned foreground service. Called next to
 * reconcileInterruptedRuns, and like it, only when no run is genuinely active.
 */
export async function clearStaleSyncState(): Promise<void> {
  if (Platform.OS !== 'android') return;
  try {
    await CopypartySync?.stopForegroundSync();
  } catch (e) {
    console.warn('[copyparty] stale service stop failed', e);
  }
  await dismissSyncNotification();
}
