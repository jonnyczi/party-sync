import { NativeModule, requireOptionalNativeModule } from 'expo';

import { CopypartyNotifyModuleEvents, NotifyImportance } from './CopypartyNotify.types';

declare class CopypartyNotifyModule extends NativeModule<CopypartyNotifyModuleEvents> {
  /** Create (idempotent) the notification channel notifications are posted to.
   *  No-op below Android O; required before posting on Android O+. */
  setChannel(channelId: string, name: string, importance: NotifyImportance): Promise<void>;

  /** Post (or update) the notification keyed by integer `notifId` on `channelId`.
   *  `ongoing` makes it sticky/non-dismissable while a run is active. Silently
   *  dropped by the system if POST_NOTIFICATIONS is not granted. */
  notify(
    channelId: string,
    notifId: number,
    title: string,
    body: string,
    ongoing: boolean,
  ): Promise<void>;

  /** Remove the notification with `notifId`. */
  dismiss(notifId: number): Promise<void>;
}

// Optional: returns null on iOS/web (this module is Android-only). Callers must
// null-check; the foreground-notification path no-ops off-Android anyway.
export default requireOptionalNativeModule<CopypartyNotifyModule>('CopypartyNotify');
