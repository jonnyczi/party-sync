import type { SourceWalker, WalkerEntry } from './types';

/**
 * source_uri sentinel — "all photos and videos, no album filter". Stored in
 * `jobs.source_uri`; the alternative form is `album:<bucketId>` (see
 * {@link ALBUM_PREFIX}), so the schema never changes — both are plain strings.
 */
export const MEDIA_SOURCE_ALL = 'all';

/**
 * Prefix for the single-album source_uri form: `album:<bucketId>`. The bucket
 * id is MediaLibrary's album id (Android: the MediaStore BUCKET_ID).
 */
export const ALBUM_PREFIX = 'album:';

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
export type MediaAlbum = { id: string; title: string };
export interface MediaLibraryLike {
  getAssetsAsync(opts: {
    first: number;
    after?: string;
    /** Album id to restrict enumeration to; omitted for the whole library. */
    album?: string;
    mediaType: ('photo' | 'video')[];
  }): Promise<MediaPage>;
  getAlbumsAsync(opts?: { includeSmartAlbums?: boolean }): Promise<MediaAlbum[]>;
}
export interface FileSizer {
  size(uri: string): Promise<number>;
}
/**
 * Maps a MediaStore URI to the one that yields the file's original bytes.
 * Resolved once per asset so a file's hash pass and its chunk reads can never
 * disagree — see {@link WalkerEntry.uri}.
 */
export interface ReadUriResolver {
  resolveReadUri(uri: string): Promise<string>;
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
 * looks new to us, which is a correctness-preserving failure mode). `uri` is
 * the same value put through `resolveReadUri`, which asks MediaStore for the
 * unredacted original — without that, Android zero-fills the EXIF GPS block on
 * read, so we would hash and upload bytes that differ from the file on disk.
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
  resolver: ReadUriResolver,
): SourceWalker {
  return {
    walk(sourceUri: string) {
      return walkMedia(sourceUri, library, sizer, resolver);
    },
  };
}

async function* walkWithLazyDeps(sourceUri: string): AsyncIterable<WalkerEntry> {
  // Lazy-load the native deps so importing this module in Node (vitest)
  // doesn't eagerly evaluate expo-media-library / the Android native module.
  const MediaLibrary = await import('expo-media-library');
  const CopypartySha512Mod = await import('../../../modules/copyparty-sha512');
  const CopypartySha512 = CopypartySha512Mod.default;
  yield* walkMedia(
    sourceUri,
    MediaLibrary as unknown as MediaLibraryLike,
    { size: (uri) => CopypartySha512.size(uri) },
    { resolveReadUri: (uri) => CopypartySha512.resolveReadUri(uri) },
  );
}

async function* walkMedia(
  sourceUri: string,
  library: MediaLibraryLike,
  sizer: FileSizer,
  resolver: ReadUriResolver,
): AsyncIterable<WalkerEntry> {
  // Resolve the source_uri sentinel into an optional album filter.
  //   'all'           → whole library (album = undefined)
  //   'album:<id>'    → that one album
  // The bucket id is the stable filter key. If it ever changes (rare — a full
  // MediaStore wipe re-buckets albums), the existence check below throws a
  // clear run-level error so the user re-picks, rather than the run silently
  // backing up nothing. After a re-pick the per-asset content-URI keys are
  // unchanged, so there's no re-upload churn; even when file_state is lost,
  // up2k dedups server-side. Garbage values throw too (strict validation).
  let album: string | undefined;
  if (sourceUri !== MEDIA_SOURCE_ALL) {
    if (!sourceUri.startsWith(ALBUM_PREFIX)) {
      throw new Error(`media walker: unrecognized source_uri '${sourceUri}'`);
    }
    const bucketId = sourceUri.slice(ALBUM_PREFIX.length);
    const albums = await library.getAlbumsAsync();
    if (!albums.some((a) => a.id === bucketId)) {
      throw new Error(
        'Album no longer exists — edit the job to pick another album.',
      );
    }
    album = bucketId;
  }
  let after: string | undefined;
  while (true) {
    const page = await library.getAssetsAsync({
      first: PAGE_SIZE,
      after,
      album,
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
      // Read through the unredacted-original URI where we're allowed to, but
      // keep `localPath` the bare content URI so file_state keys don't churn.
      let readUri = contentUri;
      try {
        readUri = await resolver.resolveReadUri(contentUri);
      } catch {
        // Resolution is an optimisation for byte fidelity, never a gate —
        // fall back to the plain URI rather than dropping the asset.
      }
      yield {
        localPath: contentUri,
        uri: readUri,
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
