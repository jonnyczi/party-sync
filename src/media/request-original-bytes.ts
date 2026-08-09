import { Alert } from 'react-native';

import CopypartySync from '../../modules/copyparty-sync';

import {
  requestOriginalBytesAccess,
  requestOriginalBytesAccessWithMediaRead,
  type OriginalBytesState,
} from './media-permission';

/**
 * The two-stage ACCESS_MEDIA_LOCATION opt-in, shared by the standing notice
 * (components/media-location-notice.tsx) and the App permissions screen
 * (app/permissions.tsx).
 *
 * Stage one is the small ask — the location permission alone, no photo library.
 * Some builds refuse it silently: measured on a Galaxy Z Fold 7 / Android 16 no
 * system dialog appears at all, and only the combined request succeeds. So
 * stage two offers that, but behind an explicit user choice rather than
 * over-asking by default. After two refusals Android stops showing the dialog
 * entirely and system settings is the only route left.
 *
 * Lives apart from ./media-permission.ts on purpose: that module is imported by
 * src/sync/triggers/periodic.ts and runs inside the headless WorkManager task,
 * so it must stay a pure PermissionsAndroid wrapper with no UI dependency.
 *
 * Alert-driven, so it cannot resolve to a final state — the promise settles as
 * soon as the alert is on screen. `onSatisfied` is invoked (possibly much later)
 * only once reads are no longer redacted; callers re-probe from it.
 */
export async function requestOriginalBytesWithEscalation(
  onSatisfied: (state: OriginalBytesState) => void,
): Promise<void> {
  // Stage one: the small ask — location only, no photo library.
  const first = await requestOriginalBytesAccess();
  if (first !== 'needs_permission') {
    onSatisfied(first);
    return;
  }

  // Some builds won't grant it standalone. Offer the larger ask rather than
  // dead-ending, but make the user opt into it knowingly.
  Alert.alert(
    'Allow photos to be read unedited',
    'Android would not grant this on its own. It can also be granted together with ' +
      'access to your photos — the app does not browse your photo library, it only ' +
      'needs this so Android stops blanking the GPS tag.',
    [
      { text: 'Not now', style: 'cancel' },
      { text: 'Open settings', onPress: openAppSettings },
      {
        text: 'Allow both',
        onPress: () => {
          void requestOriginalBytesAccessWithMediaRead().then((state) => {
            if (state !== 'needs_permission') {
              onSatisfied(state);
              return;
            }
            // Two refusals and Android stops showing the dialog at all, so
            // system settings is the only remaining route.
            Alert.alert(
              'Still blocked',
              'Android is no longer showing the permission prompt. Enable it under ' +
                'Permissions in system settings to back up photos exactly as they are.',
              [
                { text: 'Not now', style: 'cancel' },
                { text: 'Open settings', onPress: openAppSettings },
              ],
            );
          });
        },
      },
    ],
  );
}

function openAppSettings() {
  CopypartySync?.openAppSettings().catch(() => {});
}
