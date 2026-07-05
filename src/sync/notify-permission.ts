import { PermissionsAndroid, Platform } from 'react-native';

/**
 * POST_NOTIFICATIONS state after (possibly) prompting:
 * - 'granted': notifications may be posted.
 * - 'denied': the user said no to this prompt — asking again later may work.
 * - 'blocked': Android will never show the prompt again ("never ask again" /
 *   denied twice); only the system settings page can change it now, so offer
 *   the openNotificationSettings() shortcut instead of re-prompting.
 *
 * Uses React Native's built-in `PermissionsAndroid` rather than
 * `expo-notifications` so the app pulls in no Firebase/Google dependency — the
 * foreground-service notification (`./foreground`) is local-only and needs no
 * push infrastructure. POST_NOTIFICATIONS is only a runtime permission on
 * Android 13+ (API 33); older versions and non-Android platforms are permitted
 * implicitly.
 */
export type NotificationPermissionResult = 'granted' | 'denied' | 'blocked';

export async function requestNotificationPermission(): Promise<NotificationPermissionResult> {
  if (Platform.OS !== 'android') return 'granted';
  if (typeof Platform.Version === 'number' && Platform.Version < 33) return 'granted';

  const perm = PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS;
  if (await PermissionsAndroid.check(perm)) return 'granted';

  const result = await PermissionsAndroid.request(perm);
  if (result === PermissionsAndroid.RESULTS.GRANTED) return 'granted';
  if (result === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) return 'blocked';
  return 'denied';
}

/** Boolean convenience for callers that only care whether posting works. */
export async function ensureNotificationPermission(): Promise<boolean> {
  return (await requestNotificationPermission()) === 'granted';
}
