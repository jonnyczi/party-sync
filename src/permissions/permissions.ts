import { PermissionsAndroid, Platform } from 'react-native';

import CopypartySync from '../../modules/copyparty-sync';
import type { SqliteDb } from '../db/adapter';
import { listJobs } from '../db/jobs';
import { basename } from '../format';
import { getMediaReadState, getOriginalBytesState } from '../media/media-permission';
import { probeSafFolder } from '../storage/saf';

import type {
  PermissionProbeState,
  SafAccess,
  SafFolderProbe,
} from './permissions-eval';

/**
 * On-device collector feeding the pure evaluator (permissions-eval.ts).
 *
 * Split into two phases because the inputs have wildly different costs. Phase 1
 * is three permission checks, one native call and one SELECT — milliseconds.
 * Phase 2 is one SAF tree probe per folder job, which even natively is a round
 * trip to a storage provider that may be asleep. Rendering phase 1 first is
 * what stops the screen sitting empty behind the slow half; the folder rows
 * come back 'checking' so their section, heading and explanation are all on the
 * first frame rather than popping in late.
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

/** What phase 1 hands to phase 2, so the DB is read once rather than twice. */
export interface FastPermissions {
  /**
   * Renderable as-is: pass it to `evaluateAppPermissions` and every row exists,
   * with the folder rows carrying access 'checking'. Callers evaluate rather
   * than being handed items, because a caller with cached folder answers wants
   * to patch this first (see hooks/use-app-permissions.ts).
   */
  state: PermissionProbeState;
  /** Folder jobs still owing a tree probe — unset ones are already settled. */
  pending: { jobId: number; sourceUri: string }[];
}

/** Phase 1 — everything that answers in milliseconds. */
export async function readAppPermissionsFast(db: SqliteDb): Promise<FastPermissions> {
  const empty: PermissionProbeState = {
    mediaRead: 'unsupported',
    originalBytes: 'unsupported',
    notificationsEnabled: true,
    hasMediaJob: false,
    safFolders: [],
  };
  if (Platform.OS !== 'android') return { state: empty, pending: [] };

  const [mediaRead, originalBytes, notificationsEnabled, jobs] = await Promise.all([
    getMediaReadState(),
    getOriginalBytesState(),
    readNotificationsEnabled(),
    listJobs(db),
  ]);

  const safJobs = jobs.filter((j) => j.source_kind === 'saf');
  const safFolders: SafFolderProbe[] = safJobs.map((job) => ({
    jobId: job.id,
    name: job.name,
    folderLabel: decodeURIComponent(basename(job.source_uri)) || 'Folder',
    unset: job.source_uri === '',
    // An unset job needs no probe: that answer is already final.
    access: job.source_uri === '' ? 'lost' : 'checking',
  }));

  const state: PermissionProbeState = {
    mediaRead,
    originalBytes,
    notificationsEnabled,
    hasMediaJob: jobs.some((j) => j.source_kind === 'media'),
    safFolders,
  };

  return {
    state,
    pending: safJobs
      .filter((j) => j.source_uri !== '')
      .map((j) => ({ jobId: j.id, sourceUri: j.source_uri })),
  };
}

/**
 * Phase 2 — the SAF tree probes, parallel across jobs. Returns the same probe
 * state with every folder settled, ready to re-evaluate. A folder that never
 * answers settles to 'unknown', not 'lost'.
 */
export async function resolveSafFolders(
  fast: FastPermissions,
): Promise<PermissionProbeState> {
  const answers = new Map<number, SafAccess>();

  await Promise.all(
    fast.pending.map(async (p) => {
      answers.set(p.jobId, await probeSafFolder(p.sourceUri));
    }),
  );

  return {
    ...fast.state,
    safFolders: fast.state.safFolders.map((f) =>
      f.unset ? f : { ...f, access: answers.get(f.jobId) ?? f.access },
    ),
  };
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
