/**
 * Pure evaluation of the App permissions screen — no native imports so it stays
 * unit-testable under node (same split rationale as health-eval.ts vs health.ts).
 * `./permissions.ts` gathers the probe inputs on-device, including the
 * job-awareness that decides whether camera-roll access is required or optional.
 */

import type { MediaReadState, OriginalBytesState } from '../media/media-permission';

/**
 * 'checking' is only ever a folder row: the SAF tree probe is the one input
 * that cannot be answered in milliseconds, so the screen renders everything
 * else first and lets those rows settle underneath (src/permissions/permissions.ts).
 */
export type PermissionStatus = 'ok' | 'warn' | 'blocked' | 'checking';

/**
 * Surfaced next to the status so a coloured row is never ambiguous.
 * 'required' means a job that already exists cannot run without it; 'optional'
 * means the app works either way, and the row states exactly what is given up.
 */
export type RequirementLevel = 'required' | 'recommended' | 'optional';

/** Which action a row's button dispatches (app/permissions.tsx). */
export type PermissionAction =
  | 'request_media_read'
  | 'request_original_bytes'
  | 'request_notifications'
  | 'app_settings'
  | 'repick_folder';

/**
 * 'app' rows are the app-wide runtime permissions Android lists under App info →
 * Permissions. 'folders' rows are per-job SAF tree grants, which are a different
 * thing entirely and get their own section saying so.
 */
export type PermissionSection = 'app' | 'folders';

export type PermissionItemId =
  | 'media_read'
  | 'media_location'
  | 'notifications'
  | `saf:${number}`;

/**
 * Outcome of one job's SAF tree probe.
 *
 * - 'checking' — the probe has not answered yet; the screen paints first.
 * - 'ok' / 'lost' — the probe answered.
 * - 'unknown' — the probe gave up waiting. Deliberately distinct from 'lost':
 *   a folder that is merely slow is not a folder that is gone, and saying so
 *   invites a re-pick — a *different* pick silently repoints the job, and
 *   file_state keys on tree-relative paths, so it would re-upload everything.
 */
export type SafAccess = 'checking' | 'ok' | 'lost' | 'unknown';

export interface SafFolderProbe {
  jobId: number;
  /** jobs.name */
  name: string;
  /** Decoded last segment of jobs.source_uri — what the user calls the folder. */
  folderLabel: string;
  /** jobs.source_uri === '' — never picked, as opposed to picked and then lost. */
  unset: boolean;
  /** Whether the tree grant is still usable. Meaningless when `unset`. */
  access: SafAccess;
}

export interface PermissionProbeState {
  mediaRead: MediaReadState;
  originalBytes: OriginalBytesState;
  /**
   * POST_NOTIFICATIONS held AND the app's notifications not switched off
   * wholesale in system settings — the second half needs the native probe, and
   * the permission check alone reads as granted without it.
   */
  notificationsEnabled: boolean;
  /**
   * True when some job has source_kind === 'media'. Decides whether a denied
   * camera-roll permission is a blocker or a footnote.
   */
  hasMediaJob: boolean;
  /** One entry per source_kind === 'saf' job, in list order. */
  safFolders: SafFolderProbe[];
}

export interface PermissionItem {
  id: PermissionItemId;
  section: PermissionSection;
  status: PermissionStatus;
  level: RequirementLevel;
  title: string;
  /** What the current state is. */
  detail: string;
  /**
   * What leaving it in this state costs. Set only when the row is not 'ok' and
   * the permission is not required — a required row's detail already *is* the
   * consequence, and repeating it reads as padding.
   */
  caveat?: string;
  action?: PermissionAction;
  /** Set for action === 'repick_folder'. */
  jobId?: number;
}

/**
 * App rows are ordered by impact (only the first can ever block) and every one
 * is always returned, 'ok' included, so the list renders green checks rather
 * than an empty screen. Folder rows follow, one per folder job, in the order
 * given — there are none at all for a user with no folder jobs, and the screen
 * drops that whole section.
 */
export function evaluateAppPermissions(p: PermissionProbeState): PermissionItem[] {
  return [
    mediaReadItem(p),
    mediaLocationItem(p),
    notificationsItem(p),
    ...p.safFolders.map(folderItem),
  ];
}

function mediaReadItem(p: PermissionProbeState): PermissionItem {
  const base = {
    id: 'media_read',
    section: 'app',
    title: 'Photos & videos',
  } as const;

  if (p.mediaRead === 'unsupported') {
    return {
      ...base,
      status: 'ok',
      level: 'optional',
      detail: 'Camera-roll backup is Android-only.',
    };
  }

  // A camera-roll job cannot run at all without this; with no such job it is a
  // permission the app has no current use for, and saying so is more honest
  // than a red row demanding something nothing needs.
  const level: RequirementLevel = p.hasMediaJob ? 'required' : 'optional';

  if (p.mediaRead === 'full') {
    return {
      ...base,
      status: 'ok',
      level,
      detail: 'Full access — your whole camera roll can be backed up.',
    };
  }

  if (p.mediaRead === 'partial') {
    return {
      ...base,
      status: 'warn',
      level,
      detail:
        'Limited access — Android is only sharing the photos you picked, so only those ' +
        'are backed up. Photos you take from now on will not appear in the backup until ' +
        'you add them by hand.',
      caveat: 'Everything you did not pick stays off your server.',
      action: 'request_media_read',
    };
  }

  return p.hasMediaJob
    ? {
        ...base,
        status: 'blocked',
        level,
        detail:
          'Denied — your camera-roll backup cannot run at all. Every scheduled run will ' +
          'fail until this is allowed.',
        action: 'request_media_read',
      }
    : {
        ...base,
        status: 'warn',
        level,
        detail:
          'Not granted. Not needed by your current jobs — required if you add a ' +
          'camera-roll backup.',
        caveat: 'Folder backups keep working without it.',
        action: 'request_media_read',
      };
}

function mediaLocationItem(p: PermissionProbeState): PermissionItem {
  const base = {
    id: 'media_location',
    section: 'app',
    // Never required: a denial degrades fidelity, it does not stop a backup.
    level: 'optional',
    title: 'Photo location',
  } as const;

  switch (p.originalBytes) {
    case 'ok':
      return {
        ...base,
        status: 'ok',
        detail:
          'Granted — photos are backed up byte-for-byte, exactly as they are on this device.',
      };
    case 'unsupported':
      return {
        ...base,
        status: 'ok',
        detail: 'Nothing is redacted on this version of Android — there is nothing to grant.',
      };
    case 'needs_permission':
      return {
        ...base,
        status: 'warn',
        detail:
          'Not granted. Android blanks the GPS tag out of every photo this app reads — ' +
          'even a photo in a folder you picked yourself. It does not let the app find ' +
          'out where you are.',
        caveat:
          'Backed-up photos lose their location, and because the bytes no longer match ' +
          'the original your server cannot tell it already has them — so it stores a ' +
          'second copy.',
        action: 'request_original_bytes',
      };
  }
}

function notificationsItem(p: PermissionProbeState): PermissionItem {
  const base = {
    id: 'notifications',
    section: 'app',
    // Syncs run regardless; what is lost is knowing how they went.
    level: 'optional',
    title: 'Notifications',
  } as const;

  return p.notificationsEnabled
    ? {
        ...base,
        status: 'ok',
        detail: 'On — sync progress and results will be visible.',
      }
    : {
        ...base,
        status: 'warn',
        detail: 'Off — Android will not show anything this app posts.',
        caveat:
          'Syncs still run, but progress and failures are invisible: a job that has been ' +
          'failing for weeks looks exactly like one that is working.',
        action: 'request_notifications',
      };
}

function folderItem(f: SafFolderProbe): PermissionItem {
  const base = {
    id: `saf:${f.jobId}`,
    section: 'folders',
    // A folder job has exactly one source, so its grant is never optional.
    level: 'required',
    title: f.name,
    jobId: f.jobId,
  } as const;

  if (f.unset) {
    return {
      ...base,
      status: 'blocked',
      detail: 'No folder picked yet — this job cannot run.',
      action: 'repick_folder',
    };
  }

  switch (f.access) {
    case 'checking':
      // No action while it is still being checked: offering "Re-pick folder"
      // under a spinner invites a pick the user did not need to make.
      return { ...base, status: 'checking', detail: `${f.folderLabel} — checking…` };

    case 'ok':
      return { ...base, status: 'ok', detail: `${f.folderLabel} — still readable.` };

    case 'unknown':
      return {
        ...base,
        // 'warn', not 'blocked': the check gave up, which is not the same as an
        // answer. Say what is actually known and nothing more.
        status: 'warn',
        detail:
          `${f.folderLabel} did not answer in time, so this could not be checked. That ` +
          'usually means its storage — an SD card, or a cloud provider — is disconnected ' +
          'or asleep, rather than that the folder is gone.',
        action: 'repick_folder',
      };

    case 'lost':
      return {
        ...base,
        status: 'blocked',
        // Name the folder: re-picking a *different* one silently repoints the
        // job, and file_state keys on paths within the tree, so a mismatched
        // pick re-uploads everything.
        detail:
          `${f.folderLabel} is no longer readable. The access this job was granted is ` +
          'gone — the folder was moved, renamed or deleted, or Android dropped the grant.',
        action: 'repick_folder',
      };
  }
}
