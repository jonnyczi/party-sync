/**
 * Camera-roll album listing for the job editor's album picker. Kept separate
 * from the walker so both the picker (which prompts for permission) and the
 * editor's display-label resolution (which must not prompt) share one
 * permission + load path.
 *
 * Android-only in practice — the media sync pipeline (hashing) is Android-only.
 * On a platform where expo-media-library can't grant access this resolves to an
 * empty list rather than throwing.
 */
export type AlbumOption = { id: string; title: string };

/**
 * List the device's photo/video albums.
 *
 * @param opts.prompt when true, requests the Photos & Videos permission if it
 *   isn't already granted (use when the user opened the picker); when false,
 *   only reads the current permission so a passive label-resolution pass never
 *   surfaces a system dialog. Returns `[]` if permission isn't granted.
 */
export async function listMediaAlbums(opts?: {
  prompt?: boolean;
}): Promise<AlbumOption[]> {
  // Lazy-import so importing this module in Node (vitest) / on web doesn't
  // eagerly resolve the native expo-media-library module.
  const MediaLibrary = await import('expo-media-library');
  const perm = opts?.prompt
    ? await MediaLibrary.requestPermissionsAsync(false, ['photo', 'video'])
    : await MediaLibrary.getPermissionsAsync(false, ['photo', 'video']);
  if (perm.status !== 'granted') return [];
  const albums = await MediaLibrary.getAlbumsAsync();
  return albums.map((a) => ({ id: a.id, title: a.title }));
}
