import type { SafWalkBatchEvent, SafWalkEntry } from '../../../modules/copyparty-sha512';

import type { SourceWalker, WalkerEntry } from './types';

/**
 * The slice of the native module the SAF walker needs, extracted so unit tests
 * can drive the walker under Node. The module root calls `requireNativeModule`
 * at import time, which is why this file had no test before.
 */
export interface SafWalkNative {
  /** Resolves with the file count, or `WALK_CANCELLED` if it was cancelled. */
  walkTree(treeUri: string, walkId: string): Promise<number>;
  cancelWalk(walkId: string): void;
  addListener(
    event: 'onWalkBatch',
    listener: (e: SafWalkBatchEvent) => void,
  ): { remove(): void };
}

let walkSeq = 0;

/**
 * SAF-backed walker. The traversal is native (`walkTree`) because
 * expo-file-system's SAF API returns only `content://` URIs for children, with
 * no display names, so a stable `relativePath` can only be reconstructed in
 * Kotlin where the document metadata is available.
 *
 * Entries arrive in batches as `onWalkBatch` events while the native walk is
 * still running on an IO thread, and are yielded as they land. That is what
 * makes the engine's scan counters advance live and its `isCancelRequested`
 * break land mid-walk on a 10,000-file folder instead of only after it — the
 * walk used to be one atomic promise, so the UI sat on "Scanning…" and Cancel
 * did nothing for its whole duration.
 *
 * Ordering is guaranteed rather than hoped for: expo-modules-core posts both
 * event delivery and promise resolution through the same CallInvoker queue, so
 * no batch can be delivered after `walkTree` resolves.
 *
 * The backlog below is unbounded. It is bounded in practice by the size of the
 * walk, which is the same memory the previous single-shot list occupied — don't
 * add an ack protocol without a measurement saying it's needed.
 *
 * Permission revocation: `walkTree` throws when the tree's own document row is
 * unreadable. The engine wraps the scan in try/catch and surfaces it as a
 * `stat`-phase wholesale run failure; the UI then prompts to re-grant.
 */
export function createSafWalker(native: SafWalkNative): SourceWalker {
  return {
    async *walk(sourceUri: string): AsyncIterable<WalkerEntry> {
      const walkId = `saf-${Date.now()}-${walkSeq++}`;
      const pending: SafWalkEntry[][] = [];
      let done = false;
      let failure: unknown;
      let failed = false;
      let wake: (() => void) | undefined;
      const bump = (): void => {
        wake?.();
        wake = undefined;
      };

      const sub = native.addListener('onWalkBatch', (e) => {
        // A previous walk's tail can still be in flight; ignore it.
        if (e.walkId !== walkId) return;
        pending.push(e.entries);
        bump();
      });

      // Started inside the try so a synchronous throw still unsubscribes.
      let finished: Promise<void> | undefined;
      try {
        finished = native.walkTree(sourceUri, walkId).then(
          () => {
            done = true;
            bump();
          },
          (e: unknown) => {
            failure = e;
            failed = true;
            done = true;
            bump();
          },
        );

        for (;;) {
          while (pending.length > 0) {
            for (const e of pending.shift()!) {
              yield {
                localPath: e.relativePath,
                uri: e.uri,
                relativePath: e.relativePath,
                size: e.size,
                mtimeMs: e.mtimeMs,
              };
            }
          }
          // Batches already delivered are yielded before the failure surfaces —
          // a walk that dies partway still contributes what it found.
          if (failed) throw failure;
          if (done) return;
          await new Promise<void>((r) => {
            wake = r;
          });
        }
      } finally {
        sub.remove();
        // Reached on normal completion AND when the consumer breaks out of its
        // for-await (a cancel, or a throw upstream). Unknown ids are a no-op, so
        // the happy path costs nothing while a cancelled run stops the native
        // walk instead of letting it churn through the rest of the tree.
        native.cancelWalk(walkId);
        finished?.catch(() => {});
      }
    },
  };
}

export const safWalker: SourceWalker = {
  walk(sourceUri: string): AsyncIterable<WalkerEntry> {
    return walkWithLazyDeps(sourceUri);
  },
};

async function* walkWithLazyDeps(sourceUri: string): AsyncIterable<WalkerEntry> {
  // Lazy-load the native module so importing this file in Node (vitest) doesn't
  // eagerly evaluate it — same reason as the media walker.
  const { default: CopypartySha512 } = await import('../../../modules/copyparty-sha512');
  yield* createSafWalker(CopypartySha512 as unknown as SafWalkNative).walk(sourceUri);
}
