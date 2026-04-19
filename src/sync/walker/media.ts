import type { SourceWalker, WalkerEntry } from './types';

/**
 * v1 source_uri sentinel — "all photos and videos, no album filter". Album
 * selection lives in a later phase; the sentinel is stored in
 * `jobs.source_uri` so the schema doesn't change when we add
 * `album:<bucketId>`.
 */
export const MEDIA_SOURCE_ALL = 'all';

/** Minimal shapes we consume — kept local so unit tests don't need the
 *  expo-media-library types, and so the native-only imports can stay lazy. */
export type MediaAsset = {
  id: string;
  filename: string;
  mediaType: 'photo' | 'video' | 'audio' | 'unknown' | 'pairedVideo';
  modificationTime: number;
};
export interface MediaPage {
  assets: MediaAsset[];
  endCursor: string;
  hasNextPage: boolean;
}
export interface MediaLibraryLike {
  getAssetsAsync(opts: {
    first: number;
    after?: string;
    mediaType: ('photo' | 'video')[];
  }): Promise<MediaPage>;
}
export interface FileSizer {
  size(uri: string): Promise<number>;
}

const PAGE_SIZE = 200;

/**
 * MediaLibrary-backed walker. Enumerates the user's camera roll (photos +
 * videos) via paginated getAssetsAsync calls, yielding one WalkerEntry per
 * asset.
 *
 * `localPath` is the MediaStore content URI — it's the stable key across
 * runs (MediaStore ids survive normal device use; a full MediaStore wipe is
 * rare enough to punt on, and when it does happen every previous upload
 * looks new to us, which is a correctness-preserving failure mode). It's
 * also directly openable by the native module, so `uri` is the same value.
 *
 * Why NOT `asset.uri`: on Android 10+ scoped storage `asset.uri` is a
 * `file://` path that a sandboxed app can't open without
 * `MANAGE_EXTERNAL_STORAGE`. The MediaStore content URI
 * (`content://media/external/{images,video}/media/<id>`) opens with just
 * `READ_MEDIA_IMAGES`/`READ_MEDIA_VIDEO`, which is all the manifest asks.
 *
 * Why we call `size()` per asset: MediaLibrary's `Asset` type has no `size`
 * field and neither does `getAssetInfoAsync`. The native module's `size()`
 * is a cheap `OpenableColumns.SIZE` query against the content URI; hashing
 * dwarfs the per-asset bridge cost.
 *
 * iOS: unsupported in Phase 4 — the hashing native module is Android-only
 * and iOS asset URIs are `ph://…` which the module doesn't read. The
 * walker throws in a way the engine surfaces as a run-level failure.
 */
export const mediaWalker: SourceWalker = {
  walk(sourceUri: string): AsyncIterable<WalkerEntry> {
    return walkWithLazyDeps(sourceUri);
  },
};

/**
 * DI entry point for unit tests. Production callers use the `mediaWalker`
 * singleton above, which lazily binds to the real MediaLibrary + native
 * module at first-use time (so Node-side tests can import this file
 * without resolving expo-media-library).
 */
export function createMediaWalker(
  library: MediaLibraryLike,
  sizer: FileSizer,
): SourceWalker {
  return {
    walk(sourceUri: string) {
      return walkMedia(sourceUri, library, sizer);
    },
  };
}

async function* walkWithLazyDeps(sourceUri: string): AsyncIterable<WalkerEntry> {
  // Lazy-load the native deps so importing this module in Node (vitest)
  // doesn't eagerly evaluate expo-media-library / the Android native module.
  const MediaLibrary = await import('expo-media-library');
  const CopypartySha512Mod = await import('../../../modules/copyparty-sha512');
  const CopypartySha512 = CopypartySha512Mod.default;
  yield* walkMedia(sourceUri, MediaLibrary as unknown as MediaLibraryLike, {
    size: (uri) => CopypartySha512.size(uri),
  });
}

async function* walkMedia(
  sourceUri: string,
  library: MediaLibraryLike,
  sizer: FileSizer,
): AsyncIterable<WalkerEntry> {
  if (sourceUri !== MEDIA_SOURCE_ALL) {
    throw new Error(
      `media walker only supports source_uri '${MEDIA_SOURCE_ALL}' in v1; got '${sourceUri}'`,
    );
  }
  let after: string | undefined;
  while (true) {
    const page = await library.getAssetsAsync({
      first: PAGE_SIZE,
      after,
      mediaType: ['photo', 'video'],
    });
    for (const asset of page.assets) {
      const contentUri = mediaStoreUri(asset.id, asset.mediaType);
      if (!contentUri) continue;
      let size: number;
      try {
        size = await sizer.size(contentUri);
      } catch {
        // Asset disappeared between the MediaStore query and the size()
        // follow-up — treat as if it hadn't been enumerated. The engine
        // will see it again (or not) on the next run.
        continue;
      }
      yield {
        localPath: contentUri,
        uri: contentUri,
        relativePath: asset.filename,
        size,
        mtimeMs: asset.modificationTime,
      };
    }
    if (!page.hasNextPage) break;
    after = page.endCursor;
  }
}

function mediaStoreUri(id: string, mediaType: MediaAsset['mediaType']): string | null {
  if (mediaType === 'photo') return `content://media/external/images/media/${id}`;
  if (mediaType === 'video') return `content://media/external/video/media/${id}`;
  return null;
}
