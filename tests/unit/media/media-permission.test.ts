import { beforeEach, describe, expect, it, vi } from 'vitest';

// The module is pure logic over PermissionsAndroid + Platform; stub react-native
// so it runs under the node environment (same approach as status-colors.test.ts).
// vi.mock is hoisted above the module body, so everything it closes over has to
// come from vi.hoisted.
const { state, PERMISSIONS, asked, grantOnRequest } = vi.hoisted(() => ({
  state: { os: 'android' as string, version: 36 as number, granted: new Set<string>() },
  PERMISSIONS: {
    READ_MEDIA_IMAGES: 'android.permission.READ_MEDIA_IMAGES',
    READ_MEDIA_VIDEO: 'android.permission.READ_MEDIA_VIDEO',
    READ_MEDIA_VISUAL_USER_SELECTED: 'android.permission.READ_MEDIA_VISUAL_USER_SELECTED',
    READ_EXTERNAL_STORAGE: 'android.permission.READ_EXTERNAL_STORAGE',
    ACCESS_MEDIA_LOCATION: 'android.permission.ACCESS_MEDIA_LOCATION',
  },
  /** Each entry is one permission request, in call order. */
  asked: [] as string[][],
  /** Permissions the fake OS will grant when asked. */
  grantOnRequest: new Set<string>(),
}));

vi.mock('react-native', () => ({
  get Platform() {
    return { get OS() { return state.os; }, get Version() { return state.version; } };
  },
  PermissionsAndroid: {
    PERMISSIONS,
    RESULTS: { GRANTED: 'granted', DENIED: 'denied', NEVER_ASK_AGAIN: 'never_ask_again' },
    check: async (p: string) => state.granted.has(p),
    request: async (p: string) => {
      asked.push([p]);
      if (grantOnRequest.has(p)) state.granted.add(p);
      return state.granted.has(p) ? 'granted' : 'denied';
    },
    requestMultiple: async (ps: string[]) => {
      asked.push([...ps]);
      const out: Record<string, string> = {};
      for (const p of ps) {
        if (grantOnRequest.has(p)) state.granted.add(p);
        out[p] = state.granted.has(p) ? 'granted' : 'denied';
      }
      return out;
    },
  },
}));

import {
  getOriginalBytesState,
  hasMediaReadPermission,
  requestOriginalBytesAccess,
  requestOriginalBytesAccessWithMediaRead,
} from '@/src/media/media-permission';

beforeEach(() => {
  state.os = 'android';
  state.version = 36;
  state.granted.clear();
  grantOnRequest.clear();
  asked.length = 0;
});

describe('getOriginalBytesState', () => {
  it('is unsupported below Android 10, where nothing is redacted', async () => {
    state.version = 28;
    expect(await getOriginalBytesState()).toBe('unsupported');
  });

  it('is unsupported off Android', async () => {
    state.os = 'ios';
    expect(await getOriginalBytesState()).toBe('unsupported');
  });

  it('needs permission when ACCESS_MEDIA_LOCATION is not held', async () => {
    state.granted.add(PERMISSIONS.READ_MEDIA_IMAGES);
    expect(await getOriginalBytesState()).toBe('needs_permission');
  });

  it('is ok on the location permission alone, with no media read at all', async () => {
    // The whole point of the small ask: a folder job must not need the photo
    // library just to read a photo unedited.
    state.granted.add(PERMISSIONS.ACCESS_MEDIA_LOCATION);
    expect(await hasMediaReadPermission()).toBe(false);
    expect(await getOriginalBytesState()).toBe('ok');
  });
});

describe('requestOriginalBytesAccess (stage one)', () => {
  it('asks for the location permission only — never the photo library', async () => {
    grantOnRequest.add(PERMISSIONS.ACCESS_MEDIA_LOCATION);

    expect(await requestOriginalBytesAccess()).toBe('ok');
    expect(asked).toEqual([[PERMISSIONS.ACCESS_MEDIA_LOCATION]]);
  });

  it('reports needs_permission when the grant does not land, without escalating', async () => {
    expect(await requestOriginalBytesAccess()).toBe('needs_permission');
    // Escalation is the caller's decision, made explicitly by the user.
    expect(asked).toEqual([[PERMISSIONS.ACCESS_MEDIA_LOCATION]]);
  });

  it('short-circuits when already satisfied', async () => {
    state.granted.add(PERMISSIONS.ACCESS_MEDIA_LOCATION);
    expect(await requestOriginalBytesAccess()).toBe('ok');
    expect(asked).toEqual([]);
  });
});

describe('requestOriginalBytesAccessWithMediaRead (stage two)', () => {
  it('adds photo read but never video — a folder job has no use for video access', async () => {
    grantOnRequest.add(PERMISSIONS.ACCESS_MEDIA_LOCATION);
    grantOnRequest.add(PERMISSIONS.READ_MEDIA_IMAGES);

    expect(await requestOriginalBytesAccessWithMediaRead()).toBe('ok');
    expect(asked).toEqual([
      [PERMISSIONS.READ_MEDIA_IMAGES, PERMISSIONS.ACCESS_MEDIA_LOCATION],
    ]);
    expect(asked.flat()).not.toContain(PERMISSIONS.READ_MEDIA_VIDEO);
  });

  it('uses READ_EXTERNAL_STORAGE below API 33', async () => {
    state.version = 32;
    grantOnRequest.add(PERMISSIONS.ACCESS_MEDIA_LOCATION);

    await requestOriginalBytesAccessWithMediaRead();
    expect(asked).toEqual([
      [PERMISSIONS.READ_EXTERNAL_STORAGE, PERMISSIONS.ACCESS_MEDIA_LOCATION],
    ]);
  });

  it('still reports needs_permission if only the read half is granted', async () => {
    // Granting photo access without the location half leaves reads redacted, so
    // the notice must stay up rather than declaring victory.
    grantOnRequest.add(PERMISSIONS.READ_MEDIA_IMAGES);
    expect(await requestOriginalBytesAccessWithMediaRead()).toBe('needs_permission');
  });
});
