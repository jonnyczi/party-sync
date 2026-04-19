import CopypartySha512 from '../../../modules/copyparty-sha512';

import type { SourceWalker, WalkerEntry } from './types';

/**
 * SAF-backed walker. Delegates the actual tree traversal to the
 * `copyparty-sha512` native module's `walkTree` — the expo-file-system JS
 * API returns only content:// URIs for SAF children (no display names), so
 * reconstructing a stable `relativePath` has to happen in Kotlin where
 * `DocumentFile.name` is available.
 *
 * Permission revocation detection: if the user clears the app's persisted
 * URI permissions (or the SAF grant otherwise expires), `walkTree` throws.
 * The engine wraps the enumerate step in try/catch and surfaces it as a
 * `stat`-phase wholesale failure for the run; the UI then prompts to
 * re-grant.
 */
export const safWalker: SourceWalker = {
  async *walk(sourceUri: string): AsyncIterable<WalkerEntry> {
    const entries = await CopypartySha512.walkTree(sourceUri);
    for (const e of entries) {
      yield {
        localPath: e.relativePath,
        uri: e.uri,
        relativePath: e.relativePath,
        size: e.size,
        mtimeMs: e.mtimeMs,
      };
    }
  },
};
