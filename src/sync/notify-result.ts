import * as Linking from 'expo-linking';
import { Platform } from 'react-native';

import CopypartyNotify from '../../modules/copyparty-notify';
import type { SqliteDb } from '../db/adapter';
import { getResultNotificationsEnabled } from '../db/settings';
import type { JobRow, RunRow } from '../db/types';

import { formatRunResultNotification } from './notify-result-format';

// Default-importance channel for tappable result notifications — distinct from
// the low-importance `copyparty-sync` ongoing channel so users can mute results
// separately in system settings. Stays androidx.core-only (no Firebase/GMS).
const CHANNEL_ID = 'copyparty-results';
// Keep result ids well clear of the single ongoing-sync slot (id 1) and unique
// per run so several periodic-run results can coexist in the shade.
const RESULT_NOTIF_BASE = 1_000_000;

let channelReady = false;

async function ensureResultChannel(): Promise<void> {
  if (Platform.OS !== 'android' || channelReady || !CopypartyNotify) return;
  await CopypartyNotify.setChannel(CHANNEL_ID, 'Sync results', 'default');
  channelReady = true;
}

/**
 * Post a result notification for a finished run, gated by the global kill-switch
 * and the job's per-outcome toggles. No-op off-Android, when the native module
 * is null, for non-terminal statuses (`running`/`skipped`/`cancelled`), or when
 * the relevant toggle is off. Tapping deep-links to the run detail.
 *
 * Best-effort: callers treat a thrown error as non-fatal, but we also guard
 * each toggle so a disabled outcome costs nothing.
 */
export async function notifyRunResult(
  db: SqliteDb,
  run: RunRow,
  job: JobRow,
): Promise<void> {
  if (Platform.OS !== 'android' || !CopypartyNotify) return;

  const success = run.status === 'ok';
  const failure = run.status === 'partial' || run.status === 'failed';
  if (!success && !failure) return; // running / skipped / cancelled

  if (success && job.notify_on_success !== 1) return;
  if (failure && job.notify_on_failure !== 1) return;

  // Global master kill-switch (Settings tab).
  if (!(await getResultNotificationsEnabled(db))) return;

  await ensureResultChannel();
  const { title, body } = formatRunResultNotification(run, job.name);
  const deepLink = Linking.createURL(`/run/${run.id}`);
  await CopypartyNotify.notify(
    CHANNEL_ID,
    RESULT_NOTIF_BASE + run.id,
    title,
    body,
    false,
    deepLink,
  );
}
