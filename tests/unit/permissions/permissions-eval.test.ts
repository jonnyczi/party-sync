import { describe, expect, it } from 'vitest';

import {
  evaluateAppPermissions,
  type PermissionItem,
  type PermissionProbeState,
  type SafFolderProbe,
} from '@/src/permissions/permissions-eval';

/** Everything granted, one camera-roll job, no folder jobs. */
const granted: PermissionProbeState = {
  mediaRead: 'full',
  originalBytes: 'ok',
  notificationsEnabled: true,
  hasMediaJob: true,
  safFolders: [],
};

const folder = (over: Partial<SafFolderProbe> = {}): SafFolderProbe => ({
  jobId: 7,
  name: 'Camera backup',
  folderLabel: 'DCIM',
  unset: false,
  access: 'ok',
  ...over,
});

function itemById(p: PermissionProbeState): Map<string, PermissionItem> {
  return new Map(evaluateAppPermissions(p).map((i) => [i.id, i]));
}

describe('evaluateAppPermissions', () => {
  it('returns the three app-permission rows, every one ok, on a fully granted device', () => {
    const items = evaluateAppPermissions(granted);
    expect(items).toHaveLength(3);
    expect(items.every((i) => i.status === 'ok')).toBe(true);
    expect(items.every((i) => i.section === 'app')).toBe(true);
  });

  it('orders app rows by impact: photos, photo location, notifications', () => {
    expect(evaluateAppPermissions(granted).map((i) => i.id)).toEqual([
      'media_read',
      'media_location',
      'notifications',
    ]);
  });

  describe('photos & videos', () => {
    it('blocks the row and labels it required when a media job exists and access is denied', () => {
      const item = itemById({ ...granted, mediaRead: 'denied' }).get('media_read')!;
      expect(item.status).toBe('blocked');
      expect(item.level).toBe('required');
      expect(item.action).toBe('request_media_read');
    });

    it('downgrades to an optional warning when no job reads the camera roll', () => {
      const item = itemById({
        ...granted,
        mediaRead: 'denied',
        hasMediaJob: false,
      }).get('media_read')!;
      expect(item.status).toBe('warn');
      expect(item.level).toBe('optional');
    });

    it('says the permission is not needed by the current jobs when there is no media job', () => {
      const item = itemById({
        ...granted,
        mediaRead: 'denied',
        hasMediaJob: false,
      }).get('media_read')!;
      expect(item.detail).toContain('Not needed by your current jobs');
      expect(item.caveat).toContain('Folder backups keep working');
    });

    it('flags Android 14 partial access as a warning, not a denial', () => {
      const item = itemById({ ...granted, mediaRead: 'partial' }).get('media_read')!;
      expect(item.status).toBe('warn');
      expect(item.detail).toContain('only sharing the photos you picked');
      expect(item.action).toBe('request_media_read');
    });

    it('keeps partial access labelled required when a media job exists', () => {
      const item = itemById({ ...granted, mediaRead: 'partial' }).get('media_read')!;
      expect(item.level).toBe('required');
    });

    it('leaves the row ok and optional on an unsupported platform', () => {
      const item = itemById({ ...granted, mediaRead: 'unsupported' }).get('media_read')!;
      expect(item.status).toBe('ok');
      expect(item.level).toBe('optional');
      expect(item.action).toBeUndefined();
    });
  });

  describe('photo location', () => {
    it('is always optional, even when a media job exists', () => {
      for (const originalBytes of ['ok', 'needs_permission', 'unsupported'] as const) {
        const item = itemById({ ...granted, originalBytes }).get('media_location')!;
        expect(item.level).toBe('optional');
      }
    });

    it('never blocks — a denial degrades fidelity, it does not stop a backup', () => {
      const item = itemById({ ...granted, originalBytes: 'needs_permission' }).get(
        'media_location',
      )!;
      expect(item.status).toBe('warn');
    });

    it('states the dedup cost in its caveat when denied', () => {
      const item = itemById({ ...granted, originalBytes: 'needs_permission' }).get(
        'media_location',
      )!;
      expect(item.caveat).toContain('second copy');
      expect(item.caveat).toContain('lose their location');
    });

    it('is ok with no caveat where nothing is redacted', () => {
      const item = itemById({ ...granted, originalBytes: 'unsupported' }).get(
        'media_location',
      )!;
      expect(item.status).toBe('ok');
      expect(item.caveat).toBeUndefined();
    });
  });

  describe('notifications', () => {
    it('is optional and warns rather than blocks when off', () => {
      const item = itemById({ ...granted, notificationsEnabled: false }).get('notifications')!;
      expect(item.level).toBe('optional');
      expect(item.status).toBe('warn');
      expect(item.action).toBe('request_notifications');
    });

    it('says failures become invisible in its caveat', () => {
      const item = itemById({ ...granted, notificationsEnabled: false }).get('notifications')!;
      expect(item.caveat).toContain('invisible');
    });
  });

  describe('folder access', () => {
    it('emits no folder rows when no job backs up a folder', () => {
      expect(evaluateAppPermissions(granted).some((i) => i.section === 'folders')).toBe(false);
    });

    it('emits one row per SAF job, in the order given, in the folders section', () => {
      const items = evaluateAppPermissions({
        ...granted,
        safFolders: [folder({ jobId: 1 }), folder({ jobId: 2 }), folder({ jobId: 3 })],
      });
      const folders = items.filter((i) => i.section === 'folders');
      expect(folders.map((i) => i.id)).toEqual(['saf:1', 'saf:2', 'saf:3']);
    });

    it('blocks a row whose grant is gone and points its action at that job', () => {
      const item = itemById({
        ...granted,
        safFolders: [folder({ access: 'lost' })],
      }).get('saf:7')!;
      expect(item.status).toBe('blocked');
      expect(item.action).toBe('repick_folder');
      expect(item.jobId).toBe(7);
    });

    it('distinguishes a folder that was never picked from one whose grant was lost', () => {
      const never = itemById({ ...granted, safFolders: [folder({ unset: true })] }).get('saf:7')!;
      const lost = itemById({ ...granted, safFolders: [folder({ access: 'lost' })] }).get(
        'saf:7',
      )!;
      expect(never.status).toBe('blocked');
      expect(lost.status).toBe('blocked');
      expect(never.detail).not.toBe(lost.detail);
      expect(never.detail).toContain('No folder picked yet');
    });

    it('names the folder in a lost-grant row so the user knows which one to re-pick', () => {
      const item = itemById({
        ...granted,
        safFolders: [folder({ access: 'lost', folderLabel: 'Pictures' })],
      }).get('saf:7')!;
      expect(item.detail).toContain('Pictures');
    });

    it('titles each row with the job name, not the folder', () => {
      const item = itemById({
        ...granted,
        safFolders: [folder({ name: 'Weekly docs' })],
      }).get('saf:7')!;
      expect(item.title).toBe('Weekly docs');
    });

    it('labels every folder row required', () => {
      const items = evaluateAppPermissions({
        ...granted,
        safFolders: [folder({ jobId: 1 }), folder({ jobId: 2, access: 'lost' })],
      }).filter((i) => i.section === 'folders');
      expect(items.every((i) => i.level === 'required')).toBe(true);
    });
  });

  describe('folder access — still checking', () => {
    it('emits a full row so the section renders before the probe lands', () => {
      const item = itemById({ ...granted, safFolders: [folder({ access: 'checking' })] }).get(
        'saf:7',
      )!;
      expect(item.status).toBe('checking');
      expect(item.section).toBe('folders');
      expect(item.level).toBe('required');
    });

    it('names the folder so the row is identifiable before it settles', () => {
      const item = itemById({
        ...granted,
        safFolders: [folder({ access: 'checking', folderLabel: 'Pictures' })],
      }).get('saf:7')!;
      expect(item.detail).toContain('Pictures');
    });

    it('offers no action — a spinner must not invite a re-pick', () => {
      const item = itemById({ ...granted, safFolders: [folder({ access: 'checking' })] }).get(
        'saf:7',
      )!;
      expect(item.action).toBeUndefined();
    });

    it('lets "never picked" win over "still checking"', () => {
      const item = itemById({
        ...granted,
        safFolders: [folder({ unset: true, access: 'checking' })],
      }).get('saf:7')!;
      expect(item.status).toBe('blocked');
      expect(item.detail).toContain('No folder picked yet');
    });
  });

  describe('folder access — could not be checked', () => {
    it('warns rather than blocks when the probe gave up', () => {
      const item = itemById({ ...granted, safFolders: [folder({ access: 'unknown' })] }).get(
        'saf:7',
      )!;
      expect(item.status).toBe('warn');
    });

    it('never accuses the grant of being gone', () => {
      const unknown = itemById({ ...granted, safFolders: [folder({ access: 'unknown' })] }).get(
        'saf:7',
      )!;
      const lost = itemById({ ...granted, safFolders: [folder({ access: 'lost' })] }).get(
        'saf:7',
      )!;
      expect(lost.detail).toContain('no longer readable');
      expect(unknown.detail).not.toContain('no longer readable');
      expect(unknown.detail).toContain('could not be checked');
    });

    it('still offers a re-pick as an escape hatch', () => {
      const item = itemById({ ...granted, safFolders: [folder({ access: 'unknown' })] }).get(
        'saf:7',
      )!;
      expect(item.action).toBe('repick_folder');
      expect(item.jobId).toBe(7);
    });
  });

  describe('invariants', () => {
    const matrix: PermissionProbeState[] = [];
    for (const mediaRead of ['full', 'partial', 'denied', 'unsupported'] as const)
      for (const originalBytes of ['ok', 'needs_permission', 'unsupported'] as const)
        for (const notificationsEnabled of [true, false])
          for (const hasMediaJob of [true, false])
            matrix.push({
              mediaRead,
              originalBytes,
              notificationsEnabled,
              hasMediaJob,
              // Every SafAccess value, so an invariant cannot hold by only ever
              // seeing settled folders.
              safFolders: [
                folder({ jobId: 1, access: 'ok' }),
                folder({ jobId: 2, access: 'lost' }),
                folder({ jobId: 3, access: 'checking' }),
                folder({ jobId: 4, access: 'unknown' }),
              ],
            });

    it('never marks an optional row blocked', () => {
      for (const p of matrix)
        for (const item of evaluateAppPermissions(p))
          expect(item.level === 'optional' && item.status === 'blocked').toBe(false);
    });

    it('gives every not-ok optional row a caveat', () => {
      for (const p of matrix)
        for (const item of evaluateAppPermissions(p))
          if (item.status !== 'ok' && item.level === 'optional')
            expect(item.caveat, `${item.id} has no caveat`).toBeTruthy();
    });

    it('gives every ok row neither a caveat nor an action', () => {
      for (const p of matrix)
        for (const item of evaluateAppPermissions(p))
          if (item.status === 'ok') {
            expect(item.caveat).toBeUndefined();
            expect(item.action).toBeUndefined();
          }
    });

    it('gives every settled not-ok row an action to take', () => {
      for (const p of matrix)
        for (const item of evaluateAppPermissions(p))
          if (item.status !== 'ok' && item.status !== 'checking')
            expect(item.action, `${item.id}`).toBeTruthy();
    });

    it('never offers an action on a row it is still checking', () => {
      for (const p of matrix)
        for (const item of evaluateAppPermissions(p))
          if (item.status === 'checking') expect(item.action, `${item.id}`).toBeUndefined();
    });
  });

  it('reports multiple simultaneous problems independently', () => {
    const items = evaluateAppPermissions({
      mediaRead: 'denied',
      originalBytes: 'needs_permission',
      notificationsEnabled: false,
      hasMediaJob: true,
      safFolders: [folder({ jobId: 1 }), folder({ jobId: 2, access: 'lost' })],
    });
    expect(items.filter((i) => i.status === 'blocked')).toHaveLength(2);
    expect(items.filter((i) => i.status === 'warn')).toHaveLength(2);
    expect(items.filter((i) => i.status === 'ok')).toHaveLength(1);
  });
});
