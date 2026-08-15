import { describe, expect, it } from 'vitest';

import { SIZE_UNAVAILABLE } from '@/modules/copyparty-sha512/src/CopypartySha512.types';
import { createMediaWalker, MEDIA_SOURCE_ALL } from '@/src/sync/walker/media';
import type { WalkerEntry } from '@/src/sync/walker/types';

type Asset = {
  id: string;
  filename: string;
  mediaType: 'photo' | 'video' | 'audio' | 'unknown';
  modificationTime: number;
};

interface FakePage {
  assets: Asset[];
  endCursor: string;
  hasNextPage: boolean;
  totalCount: number;
}

function fakeLibrary(
  pages: FakePage[],
  albums: { id: string; title: string }[] = [],
) {
  // One call per page. We assert `after` threading so the walker can't
  // re-request page 0 by accident and stall, and capture `album` so the
  // album-filter forwarding is observable.
  const calls: { first: number; after?: string; album?: string }[] = [];
  return {
    calls,
    getAssetsAsync: async (opts: {
      first: number;
      after?: string;
      album?: string;
    }) => {
      calls.push({ first: opts.first, after: opts.after, album: opts.album });
      const idx = opts.after
        ? pages.findIndex((p, i) => i > 0 && pages[i - 1].endCursor === opts.after)
        : 0;
      if (idx < 0) throw new Error(`fake library: unknown cursor ${opts.after}`);
      return pages[idx];
    },
    getAlbumsAsync: async () => albums,
  };
}

/**
 * Batch sizer. A per-URI `Error` in the map becomes {@link SIZE_UNAVAILABLE} in
 * the returned array — the native side reports per-item failures as a sentinel
 * rather than rejecting, so one vanished asset can't take a whole page with it.
 * `calls` records each batch so tests can assert the batching itself.
 */
function fakeSizer(sizes: Record<string, number | Error>) {
  const calls: string[][] = [];
  return {
    calls,
    sizes: async (uris: string[]) => {
      calls.push(uris);
      return uris.map((uri) => {
        const v = sizes[uri];
        if (v === undefined || v instanceof Error) return SIZE_UNAVAILABLE;
        return v;
      });
    },
  };
}

/** Identity by default — production decorates MediaStore URIs for unredacted
 *  reads, but that's orthogonal to enumeration, which these tests cover.
 *  Pass `rejectWith` to model the whole batch call failing. */
function fakeResolver(
  map: Record<string, string> = {},
  rejectWith?: Error,
) {
  const calls: string[][] = [];
  return {
    calls,
    resolveReadUris: async (uris: string[]) => {
      calls.push(uris);
      if (rejectWith) throw rejectWith;
      return uris.map((uri) => map[uri] ?? uri);
    },
  };
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of iter) out.push(v);
  return out;
}

describe('mediaWalker', () => {
  it('yields one WalkerEntry per photo/video with MediaStore content URIs', async () => {
    const library = fakeLibrary([
      {
        assets: [
          { id: '1', filename: 'IMG_0001.jpg', mediaType: 'photo', modificationTime: 1000 },
          { id: '2', filename: 'VID_0001.mp4', mediaType: 'video', modificationTime: 2000 },
        ],
        endCursor: 'c1',
        hasNextPage: false,
        totalCount: 2,
      },
    ]);
    const sizer = fakeSizer({
      'content://media/external/images/media/1': 123,
      'content://media/external/video/media/2': 456_000_000,
    });

    const walker = createMediaWalker(library, sizer, fakeResolver());
    const out = await collect(walker.walk(MEDIA_SOURCE_ALL));

    expect(out).toEqual<WalkerEntry[]>([
      {
        localPath: 'content://media/external/images/media/1',
        uri: 'content://media/external/images/media/1',
        relativePath: 'IMG_0001.jpg',
        size: 123,
        mtimeMs: 1000,
      },
      {
        localPath: 'content://media/external/video/media/2',
        uri: 'content://media/external/video/media/2',
        relativePath: 'VID_0001.mp4',
        size: 456_000_000,
        mtimeMs: 2000,
      },
    ]);
  });

  it('paginates via endCursor until hasNextPage is false', async () => {
    const library = fakeLibrary([
      {
        assets: [
          { id: '1', filename: 'a.jpg', mediaType: 'photo', modificationTime: 1 },
        ],
        endCursor: 'cA',
        hasNextPage: true,
        totalCount: 2,
      },
      {
        assets: [
          { id: '2', filename: 'b.jpg', mediaType: 'photo', modificationTime: 2 },
        ],
        endCursor: 'cB',
        hasNextPage: false,
        totalCount: 2,
      },
    ]);
    const sizer = fakeSizer({
      'content://media/external/images/media/1': 10,
      'content://media/external/images/media/2': 20,
    });

    const walker = createMediaWalker(library, sizer, fakeResolver());
    const out = await collect(walker.walk(MEDIA_SOURCE_ALL));

    expect(out.map((e) => e.localPath)).toEqual([
      'content://media/external/images/media/1',
      'content://media/external/images/media/2',
    ]);
    expect(library.calls).toHaveLength(2);
    expect(library.calls[0].after).toBeUndefined();
    expect(library.calls[1].after).toBe('cA');
  });

  it('skips assets reported SIZE_UNAVAILABLE without shifting the rest of the page', async () => {
    const library = fakeLibrary([
      {
        assets: [
          { id: '1', filename: 'ok.jpg', mediaType: 'photo', modificationTime: 1 },
          { id: '2', filename: 'gone.jpg', mediaType: 'photo', modificationTime: 2 },
          { id: '3', filename: 'also-ok.jpg', mediaType: 'photo', modificationTime: 3 },
        ],
        endCursor: 'cA',
        hasNextPage: false,
        totalCount: 3,
      },
    ]);
    const sizer = fakeSizer({
      'content://media/external/images/media/1': 10,
      'content://media/external/images/media/2': new Error('no such row'),
      'content://media/external/images/media/3': 30,
    });

    const walker = createMediaWalker(library, sizer, fakeResolver());
    const out = await collect(walker.walk(MEDIA_SOURCE_ALL));

    expect(out.map((e) => e.relativePath)).toEqual(['ok.jpg', 'also-ok.jpg']);
    // Index alignment: the survivors keep their own sizes rather than
    // inheriting the next asset's.
    expect(out.map((e) => e.size)).toEqual([10, 30]);
  });

  it('stats and resolves once per page, not once per asset', async () => {
    // The whole point of the batch interfaces: a 10k-asset library used to cost
    // 20k serialized native round trips before the first byte uploaded.
    const library = fakeLibrary([
      {
        assets: [
          { id: '1', filename: 'a.jpg', mediaType: 'photo', modificationTime: 1 },
          { id: '2', filename: 'b.jpg', mediaType: 'photo', modificationTime: 2 },
          { id: '3', filename: 'c.mp4', mediaType: 'video', modificationTime: 3 },
        ],
        endCursor: 'cA',
        hasNextPage: true,
        totalCount: 4,
      },
      {
        assets: [
          { id: '4', filename: 'd.jpg', mediaType: 'photo', modificationTime: 4 },
        ],
        endCursor: 'cB',
        hasNextPage: false,
        totalCount: 4,
      },
    ]);
    const sizer = fakeSizer({
      'content://media/external/images/media/1': 10,
      'content://media/external/images/media/2': 20,
      'content://media/external/video/media/3': 30,
      'content://media/external/images/media/4': 40,
    });
    const resolver = fakeResolver();

    const walker = createMediaWalker(library, sizer, resolver);
    await collect(walker.walk(MEDIA_SOURCE_ALL));

    expect(sizer.calls).toEqual([
      [
        'content://media/external/images/media/1',
        'content://media/external/images/media/2',
        'content://media/external/video/media/3',
      ],
      ['content://media/external/images/media/4'],
    ]);
    expect(resolver.calls).toEqual(sizer.calls);
  });

  it('skips unknown mediaType rows (audio, unknown)', async () => {
    const library = fakeLibrary([
      {
        assets: [
          { id: '1', filename: 'song.mp3', mediaType: 'audio', modificationTime: 1 },
          { id: '2', filename: 'file.bin', mediaType: 'unknown', modificationTime: 2 },
          { id: '3', filename: 'img.jpg', mediaType: 'photo', modificationTime: 3 },
        ],
        endCursor: 'cA',
        hasNextPage: false,
        totalCount: 3,
      },
    ]);
    const sizer = fakeSizer({
      'content://media/external/images/media/3': 10,
    });

    const walker = createMediaWalker(library, sizer, fakeResolver());
    const out = await collect(walker.walk(MEDIA_SOURCE_ALL));

    expect(out.map((e) => e.relativePath)).toEqual(['img.jpg']);
  });

  it('rejects unrecognized source_uri sentinels', async () => {
    const walker = createMediaWalker(fakeLibrary([]), fakeSizer({}), fakeResolver());
    await expect(collect(walker.walk('garbage'))).rejects.toThrow(/unrecognized/);
  });

  it('forwards the album id to getAssetsAsync and yields that album', async () => {
    const library = fakeLibrary(
      [
        {
          assets: [
            { id: '1', filename: 'cam.jpg', mediaType: 'photo', modificationTime: 1 },
          ],
          endCursor: 'cA',
          hasNextPage: false,
          totalCount: 1,
        },
      ],
      [
        { id: 'cam', title: 'Camera' },
        { id: 'screens', title: 'Screenshots' },
      ],
    );
    const sizer = fakeSizer({ 'content://media/external/images/media/1': 10 });

    const walker = createMediaWalker(library, sizer, fakeResolver());
    const out = await collect(walker.walk('album:cam'));

    expect(out.map((e) => e.relativePath)).toEqual(['cam.jpg']);
    // Every enumeration page is scoped to the chosen album.
    expect(library.calls).toHaveLength(1);
    expect(library.calls[0].album).toBe('cam');
  });

  it('reads through the resolved URI but keys file_state on the bare one', async () => {
    // The resolved form carries ?requireOriginal=1 so Android hands back
    // unredacted EXIF. It must never reach localPath: that's the file_state
    // key, and churning it would make every photo look new.
    const bare = 'content://media/external/images/media/1';
    const library = fakeLibrary([
      {
        assets: [
          { id: '1', filename: 'geo.jpg', mediaType: 'photo', modificationTime: 1 },
        ],
        endCursor: 'cA',
        hasNextPage: false,
        totalCount: 1,
      },
    ]);
    const walker = createMediaWalker(
      library,
      fakeSizer({ [bare]: 10 }),
      fakeResolver({ [bare]: `${bare}?requireOriginal=1` }),
    );

    const [entry] = await collect(walker.walk(MEDIA_SOURCE_ALL));

    expect(entry.localPath).toBe(bare);
    expect(entry.uri).toBe(`${bare}?requireOriginal=1`);
  });

  it('falls back to the bare URI when resolution fails, without dropping the asset', async () => {
    const bare = 'content://media/external/images/media/1';
    const library = fakeLibrary([
      {
        assets: [
          { id: '1', filename: 'geo.jpg', mediaType: 'photo', modificationTime: 1 },
        ],
        endCursor: 'cA',
        hasNextPage: false,
        totalCount: 1,
      },
    ]);
    const walker = createMediaWalker(
      library,
      fakeSizer({ [bare]: 10 }),
      fakeResolver({}, new Error('resolver blew up')),
    );

    const out = await collect(walker.walk(MEDIA_SOURCE_ALL));

    // Degraded fidelity beats a missing backup.
    expect(out).toHaveLength(1);
    expect(out[0].uri).toBe(bare);
  });

  it('throws a clear error when the saved album no longer exists', async () => {
    const library = fakeLibrary([], [{ id: 'cam', title: 'Camera' }]);
    const walker = createMediaWalker(library, fakeSizer({}), fakeResolver());
    await expect(collect(walker.walk('album:gone'))).rejects.toThrow(
      /no longer exists/,
    );
  });
});
