import { PermissionsAndroid, Platform } from 'react-native';

import CopypartySync from '../../modules/copyparty-sync';
import type { SqliteDb } from '../db/adapter';
import { listJobs } from '../db/jobs';
import { basename } from '../format';
import { getMediaReadState, getOriginalBytesState } from '../media/media-permission';
import { probeSafAccess } from '../storage/saf';

import {
  evaluateAppPermissions,
  type PermissionItem,
  type SafFolderProbe,
} from './permissions-eval';

/**
 * On-device collector feeding the pure evaluator (permissions-eval.ts).
 *
 * Deliberately gates on the platform alone, unlike `readSyncHealth` — that one
 * also bails when the native module is null because every one of its probes is
 * native, whereas only the notification half of this screen is. Blanking three
 * perfectly readable rows because a binary is stale would be a worse answer
 * than showing them.
 *
 * Never prompts: a screen that raises a permission dialog just for being opened
 * is exactly the behaviour the screen exists to make unnecessary.
 */
export async function readAppPermissions(db: SqliteDb): Promise<PermissionItem[]> {
  if (Platform.OS !== 'android') return [];

  const [mediaRead, originalBytes, notificationsEnabled, jobs] = await Promise.all([
    getMediaReadState(),
    getOriginalBytesState(),
    readNotificationsEnabled(),
    listJobs(db),
  ]);

  const safFolders = await Promise.all(
    jobs.filter((j) => j.source_kind === 'saf').map(probeFolder),
  );

  return evaluateAppPermissions({
    mediaRead,
    originalBytes,
    notificationsEnabled,
    hasMediaJob: jobs.some((j) => j.source_kind === 'media'),
    safFolders,
  });
}

/**
 * Whether a notification this app posts would actually be seen.
 *
 * Two independent switches, and holding the runtime permission is only one of
 * them: the user can also turn the app's notifications off wholesale in system
 * settings, which leaves POST_NOTIFICATIONS reading as granted while every post
 * is dropped. Below API 33 there is no runtime permission at all and the native
 * probe is the whole answer.
 */
async function readNotificationsEnabled(): Promise<boolean> {
  const grantHeld =
    typeof Platform.Version === 'number' && Platform.Version < 33
      ? true
      : await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);

  // `?.` twice over: the module is null off-Android, and the *function* is
  // absent on a binary built before this probe existed (a JS reload does not
  // pick up a new native Function). Both degrade to "looks fine" rather than
  // throwing — a wrong green beats a broken screen.
  const systemEnabled = CopypartySync?.areNotificationsEnabled?.() ?? true;

  return grantHeld && systemEnabled;
}

async function probeFolder(job: {
  id: number;
  name: string;
  source_uri: string;
}): Promise<SafFolderProbe> {
  const unset = job.source_uri === '';
  return {
    jobId: job.id,
    name: job.name,
    folderLabel: decodeURIComponent(basename(job.source_uri)) || 'Folder',
    unset,
    accessible: unset ? false : await probeSafAccess(job.source_uri),
  };
}
