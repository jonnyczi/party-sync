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

/**
 * How much of the camera roll is readable.
 *
 * - 'full': READ_MEDIA_IMAGES and/or READ_MEDIA_VIDEO — the whole roll.
 * - 'partial': Android 14's "Select photos", which grants only
 *   READ_MEDIA_VISUAL_USER_SELECTED. Enumeration and reads both work, but the
 *   roll is whatever the user picked and nothing added later joins it.
 * - 'denied': nothing readable.
 * - 'unsupported': non-Android — the media pipeline (native hashing module +
 *   MediaStore URIs) is Android-only.
 */
export type MediaReadState = 'full' | 'partial' | 'denied' | 'unsupported';

export async function getMediaReadState(): Promise<MediaReadState> {
  if (Platform.OS !== 'android') return 'unsupported';

  const P = PermissionsAndroid.PERMISSIONS;
  if (typeof Platform.Version === 'number' && Platform.Version >= 33) {
    const [images, video, userSelected] = await Promise.all([
      PermissionsAndroid.check(P.READ_MEDIA_IMAGES),
      PermissionsAndroid.check(P.READ_MEDIA_VIDEO),
      PermissionsAndroid.check(P.READ_MEDIA_VISUAL_USER_SELECTED),
    ]);
    // Order matters: on API 34+ the user-selected permission is granted
    // alongside a full grant too, so it only means "partial" when both full
    // permissions are denied. Testing it first reports every device as partial.
    if (images || video) return 'full';
    return userSelected ? 'partial' : 'denied';
  }
  return (await PermissionsAndroid.check(P.READ_EXTERNAL_STORAGE)) ? 'full' : 'denied';
}

/**
 * Whether the camera roll can be enumerated and its files opened.
 *
 * Partial access counts: the roll is a subset, but every read works, and a job
 * must not be blocked over it. Callers that want to *tell the user* about the
 * subset want {@link getMediaReadState} instead.
 */
export async function hasMediaReadPermission(): Promise<boolean> {
  const state = await getMediaReadState();
  return state === 'full' || state === 'partial';
}

/**
 * Prompt for camera-roll read access and report the state afterwards.
 *
 * On Android 14+ this re-opens the photo picker when access is already partial,
 * so 'partial' is a legitimate outcome of a "grant" tap — the caller decides
 * whether to escalate to system settings. READ_MEDIA_VISUAL_USER_SELECTED is
 * only requested on API 34+, where it exists; asking for it on 33 would request
 * a permission the platform cannot grant.
 */
export async function requestMediaReadAccess(): Promise<MediaReadState> {
  if (Platform.OS !== 'android') return 'unsupported';

  const P = PermissionsAndroid.PERMISSIONS;
  const version = typeof Platform.Version === 'number' ? Platform.Version : 0;
  if (version >= 33) {
    await PermissionsAndroid.requestMultiple(
      version >= 34
        ? [P.READ_MEDIA_IMAGES, P.READ_MEDIA_VIDEO, P.READ_MEDIA_VISUAL_USER_SELECTED]
        : [P.READ_MEDIA_IMAGES, P.READ_MEDIA_VIDEO],
    );
  } else {
    await PermissionsAndroid.request(P.READ_EXTERNAL_STORAGE);
  }
  return getMediaReadState();
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

/**
 * Whether reads return the file's original bytes.
 *
 * The single predicate behind the notice, for both job kinds. Keeping it in one
 * place matters more than it looks: the request flow below has two stages, and
 * if the component recomputed "am I done?" separately from what the request
 * returns, "granted but still redacted" and "not granted" would drift apart.
 */
export type OriginalBytesState = 'ok' | 'needs_permission' | 'unsupported';

export async function getOriginalBytesState(): Promise<OriginalBytesState> {
  const perm = await getMediaLocationPermission();
  if (perm === 'unsupported') return 'unsupported';
  return perm === 'granted' ? 'ok' : 'needs_permission';
}

/**
 * Stage one of the opt-in: ask for ACCESS_MEDIA_LOCATION on its own.
 *
 * Folder jobs are affected by redaction too — on Android 16 / One UI a photo
 * read through a folder the user picked themselves comes back with its GPS
 * block blanked, though a stock AOSP build at API 35 does not do this. So the
 * ask has to reach folder jobs, but a folder backup has no business requesting
 * the whole photo library, and the permission is holdable on its own (verified:
 * granted while READ_MEDIA_IMAGES is denied). Try the small ask first.
 */
export async function requestOriginalBytesAccess(): Promise<OriginalBytesState> {
  const current = await getOriginalBytesState();
  if (current !== 'needs_permission') return current;

  await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.ACCESS_MEDIA_LOCATION);
  return getOriginalBytesState();
}

/**
 * Stage two, offered only after stage one failed: request media read alongside
 * the location permission, because some builds will not grant the latter on its
 * own. Deliberately excludes READ_MEDIA_VIDEO — a folder job needs no video
 * access, and over-asking is exactly what makes this feel like an escalation.
 *
 * Not a rare fallback: measured on a Galaxy Z Fold 7 / Android 16, the bare
 * request above is refused *silently* — no system dialog at all — and only this
 * combined request succeeds. On a stock AVD at API 35 stage one suffices. Keep
 * both; neither is dead code.
 */
export async function requestOriginalBytesAccessWithMediaRead(): Promise<OriginalBytesState> {
  const current = await getOriginalBytesState();
  if (current !== 'needs_permission') return current;

  const P = PermissionsAndroid.PERMISSIONS;
  const read =
    typeof Platform.Version === 'number' && Platform.Version >= 33
      ? P.READ_MEDIA_IMAGES
      : P.READ_EXTERNAL_STORAGE;
  await PermissionsAndroid.requestMultiple([read, P.ACCESS_MEDIA_LOCATION]);
  return getOriginalBytesState();
}
