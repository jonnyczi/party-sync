import { PermissionsAndroid, Platform } from 'react-native';

/**
 * Ensure the app may post notifications, requesting POST_NOTIFICATIONS at
 * runtime if needed. Returns whether notifications are permitted.
 *
 * Uses React Native's built-in `PermissionsAndroid` rather than
 * `expo-notifications` so the app pulls in no Firebase/Google dependency — the
 * foreground-service notification (`./foreground`) is local-only and needs no
 * push infrastructure. POST_NOTIFICATIONS is only a runtime permission on
 * Android 13+ (API 33); older versions and non-Android platforms are permitted
 * implicitly.
 */
export async function ensureNotificationPermission(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  if (typeof Platform.Version === 'number' && Platform.Version < 33) return true;

  const perm = PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS;
  if (await PermissionsAndroid.check(perm)) return true;

  const result = await PermissionsAndroid.request(perm);
  return result === PermissionsAndroid.RESULTS.GRANTED;
}
