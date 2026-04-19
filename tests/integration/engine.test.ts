import { mkdir, readdir, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { CopypartyClient } from '../../src/copyparty/client';
import { nodeFileSource } from '../../src/copyparty/hash.node';
import { createJob } from '../../src/db/jobs';
import { runMigrations } from '../../src/db/schema';
import { createServer } from '../../src/db/servers';
import { runJob } from '../../src/sync/engine';
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
});
