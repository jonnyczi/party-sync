import Constants from 'expo-constants';

/**
 * The app's display name, as users see it — notification titles, permission
 * copy, anything addressed at the person rather than the protocol.
 *
 * `app.json`'s `expo.name` is the single source of truth (it also becomes the
 * Android launcher label via prebuild), so this reads it back rather than
 * duplicating the string. The literal fallback matters: this module is reachable
 * from the headless sync path, which cold-starts without a surface, and a
 * missing manifest there would otherwise put "undefined" in a notification.
 *
 * NOT for identifiers. Anything persisted — the SQLite filename, backup format
 * tags, notification channel ids, the applicationId — is deliberately still
 * spelled `copyparty*` and must never be derived from this.
 */
export const APP_NAME = Constants.expoConfig?.name ?? 'Party Sync';
