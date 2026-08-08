import { PermissionsAndroid, Platform } from 'react-native';

/**
 * Camera-roll permission checks that are deliberately independent of
 * `expo-media-library`'s aggregate status.
 *
 * Once ACCESS_MEDIA_LOCATION is declared in the manifest, expo-media-library
 * includes it in every `get/requestPermissionsAsync` call, and expo-modules-core
 * AND-aggregates the results (a never-requested permission reads as
 * `undetermined`). So an install that granted Photos & Videos before this
 * permission existed would report `granted: false` and every media job — most
 * damagingly the background ones — would refuse to run.
 *
 * Reading media and reading its location are separate concerns, so they get
 * separate checks: {@link hasMediaReadPermission} gates whether a job can run at
 * all, {@link getMediaLocationPermission} only affects byte fidelity.
 *
 * Uses React Native's built-in `PermissionsAndroid` for the same reason
 * `../sync/notify-permission.ts` does — no extra native surface.
 */

/** Whether the camera roll can be enumerated and its files opened. */
export async function hasMediaReadPermission(): Promise<boolean> {
  // The media pipeline (native hashing module + MediaStore URIs) is Android-only.
  if (Platform.OS !== 'android') return false;

  const P = PermissionsAndroid.PERMISSIONS;
  if (typeof Platform.Version === 'number' && Platform.Version >= 33) {
    // Android 14's "Select photos" partial access grants only
    // READ_MEDIA_VISUAL_USER_SELECTED — the roll is then a subset, but
    // enumeration and reads both work, so it counts as usable.
    const checks = await Promise.all([
      PermissionsAndroid.check(P.READ_MEDIA_IMAGES),
      PermissionsAndroid.check(P.READ_MEDIA_VIDEO),
      PermissionsAndroid.check(P.READ_MEDIA_VISUAL_USER_SELECTED),
    ]);
    return checks.some(Boolean);
  }
  return PermissionsAndroid.check(P.READ_EXTERNAL_STORAGE);
}

/**
 * - 'granted': photos are read byte-for-byte as they are on disk.
 * - 'denied': Android zero-fills the EXIF GPS block on read, so uploads differ
 *   from the originals and won't dedup against copies made any other way.
 * - 'unsupported': pre-Android-10 or non-Android — nothing is redacted, so
 *   there is nothing to grant and nothing to warn about.
 */
export type MediaLocationPermission = 'granted' | 'denied' | 'unsupported';

export async function getMediaLocationPermission(): Promise<MediaLocationPermission> {
  if (Platform.OS !== 'android') return 'unsupported';
  if (typeof Platform.Version === 'number' && Platform.Version < 29) return 'unsupported';

  const perm = PermissionsAndroid.PERMISSIONS.ACCESS_MEDIA_LOCATION;
  return (await PermissionsAndroid.check(perm)) ? 'granted' : 'denied';
}

/**
 * Prompt for ACCESS_MEDIA_LOCATION. Never call this from a background trigger —
 * and never let its result block a run: a denial degrades fidelity, it does not
 * stop the backup.
 */
export async function requestMediaLocationPermission(): Promise<MediaLocationPermission> {
  const current = await getMediaLocationPermission();
  if (current !== 'denied') return current;

  const perm = PermissionsAndroid.PERMISSIONS.ACCESS_MEDIA_LOCATION;
  const result = await PermissionsAndroid.request(perm);
  return result === PermissionsAndroid.RESULTS.GRANTED ? 'granted' : 'denied';
}
