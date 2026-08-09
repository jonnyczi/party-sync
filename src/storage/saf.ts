/**
 * Whether a SAF tree grant is still usable.
 *
 * A tree grant is not an app-wide permission: the user grants access to one
 * specific folder when they pick it, and it is persisted against that job's
 * `source_uri`. It disappears if the folder is moved, renamed or deleted, if
 * its storage is unmounted, or if Android drops the app's persisted grants —
 * none of which the app is told about. Reading the directory is the only honest
 * test, so this is a probe rather than a permission check.
 *
 * Used by the Test connection button (src/copyparty/test-connection.ts) and the
 * Folder access section of the App permissions screen
 * (src/permissions/permissions.ts).
 */
export async function probeSafAccess(sourceUri: string): Promise<boolean> {
  try {
    // Lazy-require so callers can be imported in Node (vitest) without pulling
    // in expo-file-system's native module.
    const mod = await import('expo-file-system/legacy');
    await mod.StorageAccessFramework.readDirectoryAsync(sourceUri);
    return true;
  } catch {
    return false;
  }
}
