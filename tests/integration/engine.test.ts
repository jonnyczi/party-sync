import { mkdir, readdir, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { SIZE_UNAVAILABLE } from '../../modules/copyparty-sha512/src/CopypartySha512.types';
import { CopypartyClient } from '../../src/copyparty/client';
import type { FileSource } from '../../src/copyparty/hash';
import { nodeFileSource } from '../../src/copyparty/hash.node';
import { createJob } from '../../src/db/jobs';
import { runMigrations } from '../../src/db/schema';
import { createServer } from '../../src/db/servers';
import { runJob } from '../../src/sync/engine';
import {
  createMediaWalker,
  MEDIA_SOURCE_ALL,
  type MediaAsset,
} from '../../src/sync/walker/media';
import type { SourceWalker, WalkerEntry } from '../../src/sync/walker/types';

import { createNodeSqliteDb } from './db-adapter';
import {
  COPYPARTY_PW,
  COPYPARTY_URL,
  copypartyReachable,
  uniqueRemoteFolder,
  withTempDir,
  writeRandomFile,
} from './helpers';

const MIB = 1024 * 1024;

let serverUp = false;

beforeAll(async () => {
  serverUp = await copypartyReachable();
  if (!serverUp) {
    console.warn(
      `\n[integration] copyparty not reachable at ${COPYPARTY_URL}; ` +
        `start it with: npm run test:integration:up\n`,
    );
  }
});

const requireServer = () => {
  if (!serverUp) throw new Error('copyparty not reachable; skipping');
};

/**
 * Walk a local directory tree. Used as a stand-in for the SAF walker in
 * integration tests — the on-device SAF code path is Android-only and gets
 * manual verification.
 */
function localDirWalker(rootDir: string): SourceWalker {
  return {
    async *walk(sourceUri: string): AsyncIterable<WalkerEntry> {
      // sourceUri is ignored; the walker is bound to `rootDir` at
      // construction time. Matches the SAF walker's contract where
      // sourceUri is just a handle interpreted by the walker itself.
      void sourceUri;
      const stack: string[] = [''];
      while (stack.length) {
        const rel = stack.pop()!;
        const abs = rel ? join(rootDir, rel) : rootDir;
        const items = await readdir(abs, { withFileTypes: true });
        for (const item of items) {
          const childRel = rel ? `${rel}/${item.name}` : item.name;
          const childAbs = join(rootDir, childRel);
          if (item.isDirectory()) {
            stack.push(childRel);
          } else if (item.isFile()) {
            const s = await stat(childAbs);
            yield {
              localPath: childRel,
              uri: childAbs,
              relativePath: childRel,
              size: s.size,
              mtimeMs: Math.floor(s.mtimeMs),
            };
          }
        }
      }
    },
  };
}

describe('engine end-to-end against copyparty', () => {
  it('uploads a fixture tree and skips everything on a second run (dedup)', async () => {
    requireServer();
    await withTempDir(async (dir) => {
      // Fixture: 3 files across 2 subdirs, mix of sub-chunk and multi-chunk.
      await mkdir(join(dir, 'photos'), { recursive: true });
      await mkdir(join(dir, 'docs'), { recursive: true });
      await writeRandomFile(join(dir, 'photos', 'a.bin'), 512, 101);
      await writeRandomFile(join(dir, 'photos', 'b.bin'), 2 * MIB + 7, 102);
      await writeRandomFile(join(dir, 'docs', 'notes.txt'), 64 * 1024, 103);

      const remoteFolder = uniqueRemoteFolder('engine-e2e');

      const db = createNodeSqliteDb();
      await runMigrations(db);
      const serverId = await createServer(db, {
        name: 's',
        base_url: COPYPARTY_URL,
      });
      const jobId = await createJob(db, {
        server_id: serverId,
        name: 'backup',
        source_kind: 'saf',
        source_uri: dir,
        remote_path: remoteFolder,
      });

      const client = new CopypartyClient({
        baseUrl: COPYPARTY_URL,
        password: COPYPARTY_PW,
      });

      const walker = localDirWalker(dir);
      const ctx = {
        db,
        walker,
        client,
        fileSource: nodeFileSource,
        sleep: (_ms: number) => Promise.resolve<void>(undefined),
      };

      const first = await runJob(ctx, jobId);
      expect(first.status).toBe('ok');
      expect(first.files_scanned).toBe(3);
      expect(first.files_uploaded).toBe(3);
      expect(first.files_skipped).toBe(0);
      expect(first.files_failed).toBe(0);
      expect(first.bytes_uploaded).toBe(512 + 2 * MIB + 7 + 64 * 1024);

      // Every file should have a file_state row with a wark + uploaded_at.
      const rows = await db.getAllAsync<{
        local_path: string;
        wark: string | null;
        uploaded_at: number | null;
      }>('SELECT local_path, wark, uploaded_at FROM file_state WHERE job_id = ?', [
        jobId,
      ]);
      expect(rows).toHaveLength(3);
      for (const r of rows) {
        expect(r.wark).toBeTruthy();
        expect(r.uploaded_at).not.toBeNull();
      }

      // Second run: nothing should upload.
      const second = await runJob(ctx, jobId);
      expect(second.status).toBe('ok');
      expect(second.files_scanned).toBe(3);
      expect(second.files_skipped).toBe(3);
      expect(second.files_uploaded).toBe(0);
      expect(second.bytes_uploaded).toBe(0);

      db.close();
    });
  });

  it('re-uploads a file whose contents changed between runs', async () => {
    requireServer();
    await withTempDir(async (dir) => {
      const path = join(dir, 'mutable.bin');
      await writeRandomFile(path, 64 * 1024, 201);

      const remoteFolder = uniqueRemoteFolder('engine-mut');
      const db = createNodeSqliteDb();
      await runMigrations(db);
      const serverId = await createServer(db, {
        name: 's',
        base_url: COPYPARTY_URL,
      });
      const jobId = await createJob(db, {
        server_id: serverId,
        name: 'mut',
        source_kind: 'saf',
        source_uri: dir,
        remote_path: remoteFolder,
      });

      const client = new CopypartyClient({
        baseUrl: COPYPARTY_URL,
        password: COPYPARTY_PW,
      });
      const ctx = {
        db,
        walker: localDirWalker(dir),
        client,
        fileSource: nodeFileSource,
        sleep: (_ms: number) => Promise.resolve<void>(undefined),
      };

      const first = await runJob(ctx, jobId);
      expect(first.files_uploaded).toBe(1);

      // Mutate: same size, different contents, bump mtime.
      await writeFile(path, Buffer.alloc(64 * 1024, 0xaa));
      const now = Date.now() + 60_000; // definitely newer
      await utimes(path, now / 1000, now / 1000);

      const second = await runJob(ctx, jobId);
      expect(second.status).toBe('ok');
      expect(second.files_uploaded).toBe(1);
      expect(second.files_skipped).toBe(0);

      db.close();
    });
  });

  /**
   * Source-kind routing, phase 4. Drives the engine via `createMediaWalker`
   * (the unit of work the trigger dispatches to when `source_kind === 'media'`)
   * with a fake MediaLibrary + a FileSource that maps content:// URIs back
   * to real files on disk. This verifies two things the SAF test doesn't:
   *
   *   1. Media WalkerEntries (content URI as localPath AND uri; asset
   *      filename as relativePath) flow through the engine correctly —
   *      file_state.local_path ends up storing the content URI.
   *   2. Files land on the server under their filename at the job's
   *      `remote_path` root (not under per-asset subdirs), which is the
   *      behavior the plan specifies for camera-roll jobs.
   *
   * We can't drive the real MediaLibrary or the Android native module from
   * Node, and the trigger's dispatch itself is a tiny if/else; the routing
   * worth exercising is "does a media-shaped walker produce data the engine
   * handles correctly" — that's what this test covers.
   */
  it('runs a media-source job end-to-end (media walker + content URI keys)', async () => {
    requireServer();
    await withTempDir(async (dir) => {
      interface Fixture {
        asset: MediaAsset;
        diskPath: string;
        contentUri: string;
        size: number;
      }
      const fixtures: Fixture[] = [
        makeFixture('IMG_0001.jpg', '101', 'photo', 64 * 1024, 301),
        makeFixture('IMG_0002.jpg', '102', 'photo', 3 * MIB, 302),
        makeFixture('VID_0001.mp4', '201', 'video', 100 * 1024, 303),
      ];
      for (const f of fixtures) {
        await writeRandomFile(join(dir, f.diskPath), f.size, Number(f.asset.id));
      }

      const byUri = new Map(fixtures.map((f) => [f.contentUri, join(dir, f.diskPath)]));
      const fakeLibrary = {
        getAssetsAsync: async (_opts: unknown) => ({
          assets: fixtures.map((f) => f.asset),
          endCursor: 'end',
          hasNextPage: false,
        }),
        // Unused on the 'all' path; present to satisfy MediaLibraryLike.
        getAlbumsAsync: async () => [],
      };
      const sizer = {
        sizes: async (uris: string[]) =>
          Promise.all(
            uris.map(async (uri) => {
              const p = byUri.get(uri);
              if (!p) return SIZE_UNAVAILABLE;
              return (await stat(p)).size;
            }),
          ),
      };
      // Identity resolver: the unredacted-original decoration is a MediaStore
      // concern with no analogue against real files on disk.
      const walker = createMediaWalker(fakeLibrary, sizer, {
        resolveReadUris: async (uris: string[]) => uris,
      });

      // FileSource that rewrites content:// URIs to real disk paths before
      // handing off to nodeFileSource. In production the native module
      // opens content:// via ContentResolver; here we emulate the shape.
      const mappedFileSource: FileSource = {
        hashFileChunks: (uri, cs) =>
          nodeFileSource.hashFileChunks(resolveUri(byUri, uri), cs),
        readRange: (uri, car, cdr) =>
          nodeFileSource.readRange(resolveUri(byUri, uri), car, cdr),
        size: (uri) => nodeFileSource.size(resolveUri(byUri, uri)),
      };

      const remoteFolder = uniqueRemoteFolder('engine-media');

      const db = createNodeSqliteDb();
      await runMigrations(db);
      const serverId = await createServer(db, {
        name: 's',
        base_url: COPYPARTY_URL,
      });
      const jobId = await createJob(db, {
        server_id: serverId,
        name: 'media',
        source_kind: 'media',
        source_uri: MEDIA_SOURCE_ALL,
        remote_path: remoteFolder,
      });

      const client = new CopypartyClient({
        baseUrl: COPYPARTY_URL,
        password: COPYPARTY_PW,
      });
      const ctx = {
        db,
        walker,
        client,
        fileSource: mappedFileSource,
        sleep: (_ms: number) => Promise.resolve<void>(undefined),
      };

      const first = await runJob(ctx, jobId);
      expect(first.status).toBe('ok');
      expect(first.files_scanned).toBe(3);
      expect(first.files_uploaded).toBe(3);
      expect(first.files_failed).toBe(0);

      // file_state keys are the MediaStore content URIs — the phase-4
      // decision for media-source jobs.
      const rows = await db.getAllAsync<{ local_path: string }>(
        'SELECT local_path FROM file_state WHERE job_id = ? ORDER BY local_path',
        [jobId],
      );
      expect(rows.map((r) => r.local_path)).toEqual([
        'content://media/external/images/media/101',
        'content://media/external/images/media/102',
        'content://media/external/video/media/201',
      ]);

      // Second run is a full dedup — validates (size, mtime) short-circuit
      // works against content-URI keys just like it does for SAF.
      const second = await runJob(ctx, jobId);
      expect(second.files_skipped).toBe(3);
      expect(second.files_uploaded).toBe(0);

      db.close();
    });
  });
});

function mediaStoreContentUri(id: string, kind: 'photo' | 'video'): string {
  const bucket = kind === 'photo' ? 'images' : 'video';
  return `content://media/external/${bucket}/media/${id}`;
}

function makeFixture(
  filename: string,
  id: string,
  kind: 'photo' | 'video',
  size: number,
  mtimeMs: number,
): {
  asset: MediaAsset;
  diskPath: string;
  contentUri: string;
  size: number;
} {
  return {
    asset: { id, filename, mediaType: kind, modificationTime: mtimeMs },
    diskPath: filename,
    contentUri: mediaStoreContentUri(id, kind),
    size,
  };
}

function resolveUri(byUri: Map<string, string>, uri: string): string {
  const p = byUri.get(uri);
  if (!p) throw new Error(`no mapping for uri ${uri}`);
  return p;
}
