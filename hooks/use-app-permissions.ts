import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import type { SqliteDb } from '@/src/db/adapter';
import {
  readAppPermissionsFast,
  resolveSafFolders,
  type FastPermissions,
} from '@/src/permissions/permissions';
import {
  evaluateAppPermissions,
  type PermissionItem,
  type SafAccess,
} from '@/src/permissions/permissions-eval';

/** A folder answer worth reusing, and the URI it was an answer *about*. */
type CachedAccess = { sourceUri: string; access: SafAccess };

/**
 * Drives the App permissions screen: probe on the right triggers, in two
 * phases, without ever showing the user a worse answer than it already had.
 *
 * Three things here are load-bearing and easy to undo by accident:
 *
 * 1. **Both triggers are needed and neither subsumes the other.** Returning
 *    from a system settings Activity is an AppState change with no focus event,
 *    while dismissing the job edit modal after re-picking a folder is a focus
 *    event with no AppState change. (useFocusEffect also covers mount.)
 *
 * 2. **One generation counter, checked after *both* awaits.** Probing a SAF
 *    tree has unbounded latency and focus + resume routinely fire together, so
 *    two probes overlap and the slower one must not overwrite the newer answer.
 *    A second counter per phase would let a stale phase 2 land on top of a
 *    fresh phase 1.
 *
 * 3. **Settled folder rows are seeded back into phase 1.** Without that, every
 *    resume would reset a known-good row to a spinner for the duration of the
 *    next probe — worse than the blank screen this replaces. The seed is keyed
 *    by job *and* source_uri so a re-pick always invalidates its own entry, and
 *    'unknown' is never seeded because a timeout deserves a retry.
 */
export function useAppPermissions(db: SqliteDb) {
  const [items, setItems] = useState<PermissionItem[]>([]);
  const generation = useRef(0);
  const seed = useRef(new Map<number, CachedAccess>());

  const probe = useCallback(() => {
    const mine = ++generation.current;

    void (async () => {
      try {
        const fast = await readAppPermissionsFast(db);
        if (mine !== generation.current) return;

        const seeded = applySeed(fast, seed.current);
        setItems(evaluateAppPermissions(seeded.state));
        if (seeded.pending.length === 0) return;

        // Deliberately re-probes even the seeded rows: catching a grant that
        // went away is the whole point, and natively that costs ~10ms.
        const settled = await resolveSafFolders(seeded);
        if (mine !== generation.current) return;

        remember(settled.safFolders, seeded, seed.current);
        setItems(evaluateAppPermissions(settled));
      } catch (e) {
        console.warn('[copyparty] permission probe failed', e);
      }
    })();
  }, [db]);

  useFocusEffect(
    useCallback(() => {
      probe();
    }, [probe]),
  );

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') probe();
    });
    return () => sub.remove();
  }, [probe]);

  return { items, refresh: probe };
}

/** Show what we already know instead of a spinner, while phase 2 re-checks. */
function applySeed(
  fast: FastPermissions,
  cache: ReadonlyMap<number, CachedAccess>,
): FastPermissions {
  if (cache.size === 0) return fast;

  const uriOf = new Map(fast.pending.map((p) => [p.jobId, p.sourceUri]));
  return {
    ...fast,
    state: {
      ...fast.state,
      safFolders: fast.state.safFolders.map((f) => {
        const hit = cache.get(f.jobId);
        if (f.unset || !hit || hit.sourceUri !== uriOf.get(f.jobId)) return f;
        return { ...f, access: hit.access };
      }),
    },
  };
}

function remember(
  settled: FastPermissions['state']['safFolders'],
  fast: FastPermissions,
  cache: Map<number, CachedAccess>,
) {
  const uriOf = new Map(fast.pending.map((p) => [p.jobId, p.sourceUri]));
  for (const f of settled) {
    const sourceUri = uriOf.get(f.jobId);
    // 'unknown' is a timeout, not an answer — retry it on the next trigger
    // rather than pinning the row to "could not check" forever.
    if (!sourceUri || f.access === 'unknown' || f.access === 'checking') continue;
    cache.set(f.jobId, { sourceUri, access: f.access });
  }
}
