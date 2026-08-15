/**
 * Whether a SAF tree grant is still usable.
 *
 * A tree grant is not an app-wide permission: the user grants access to one
 * specific folder when they pick it, and it is persisted against that job's
 * `source_uri`. It disappears if the folder is moved, renamed or deleted, if
 * its storage is unmounted, or if Android drops the app's persisted grants —
 * none of which the app is told about. Reading the tree is the only honest
 * test, so this is a probe rather than a permission check.
 *
 * The probe is native (`canReadFolder`): one row from the tree's own document.
 * The original JS answer, `readDirectoryAsync`, enumerates every child and
 * marshals one URI string per file across the bridge, so it costs O(children) —
 * seconds on a camera roll, which is what made the App permissions screen sit
 * blank. It survives as the fallback for a binary predating the native
 * function.
 *
 * Used by the Test connection button (src/copyparty/test-connection.ts) and the
 * Folder access section of the App permissions screen
 * (src/permissions/permissions.ts).
 */

/**
 * 'unknown' is deliberately distinct from 'lost': a folder that did not answer
 * is not a folder that is gone, and telling the user otherwise invites a
 * re-pick — a *different* pick silently repoints the job, and file_state keys
 * on tree-relative paths, so it would re-upload everything.
 */
export type SafProbeResult = 'ok' | 'lost' | 'unknown';

/**
 * Budget for the App permissions screen, which probes on every focus and every
 * resume. The native probe answers in single-digit milliseconds, so this only
 * ever fires on a wedged storage provider — or on the O(children) fallback,
 * where it still covers a large folder on mid-range hardware while capping the
 * worst case at one spinner cycle.
 */
export const SAF_PROBE_TIMEOUT_MS = 4_000;

/**
 * Test connection is user-initiated and blocking, so it can afford to wait out
 * a slow-but-working volume rather than report a false negative.
 */
const TEST_CONNECTION_TIMEOUT_MS = 15_000;

export async function probeSafFolder(
  sourceUri: string,
  timeoutMs: number = SAF_PROBE_TIMEOUT_MS,
): Promise<SafProbeResult> {
  if (!sourceUri) return 'lost';

  try {
    // Lazy-import for the same reason as expo-file-system below: this module is
    // reachable from src/copyparty/test-connection.ts, whose callers are
    // unit-tested under node, and `requireOptionalNativeModule` pulls in expo's
    // async-require setup (which needs __DEV__) at module scope.
    const { default: CopypartySync } = await import('../../modules/copyparty-sync');

    // `undefined` here means the native Function is absent — the module is null
    // off-Android, or the binary predates it and a JS reload does not add it.
    // A real answer is never undefined, so the two cases cannot be confused.
    const answer = await CopypartySync?.canReadFolder?.(sourceUri, timeoutMs);
    if (answer === true) return 'ok';
    if (answer === false) return 'lost';
    if (answer === null) return 'unknown';
  } catch (e) {
    console.warn('[copyparty] canReadFolder failed, falling back to enumeration', e);
  }

  return enumerationProbe(sourceUri, timeoutMs);
}

/**
 * The original probe, kept as the fallback for a stale binary. Reading the
 * directory enumerates every child, so it is O(children) — the reason
 * canReadFolder exists.
 */
async function enumerationProbe(
  sourceUri: string,
  timeoutMs: number,
): Promise<SafProbeResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<SafProbeResult>((resolve) => {
    timer = setTimeout(() => resolve('unknown'), timeoutMs);
  });

  const read = (async (): Promise<SafProbeResult> => {
    try {
      // Lazy-require so callers can be imported in Node (vitest) without pulling
      // in expo-file-system's native module.
      const mod = await import('expo-file-system/legacy');
      await mod.StorageAccessFramework.readDirectoryAsync(sourceUri);
      return 'ok';
    } catch {
      return 'lost';
    }
  })();

  try {
    // Losing the race abandons the read, it does not cancel it — the native
    // enumeration runs to completion regardless. Nothing here can stop it,
    // which is the second reason to prefer the native probe.
    return await Promise.race([read, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Boolean form for the Test connection button, which wants a plain pass/fail.
 *
 * Note this collapses 'unknown' into false, so a volume that stays silent for
 * 15s reports as "permission gone". Acceptable there because the check is
 * user-initiated and retryable; the permissions screen uses probeSafFolder so
 * it can say "could not check" instead.
 */
export async function probeSafAccess(sourceUri: string): Promise<boolean> {
  return (await probeSafFolder(sourceUri, TEST_CONNECTION_TIMEOUT_MS)) === 'ok';
}
