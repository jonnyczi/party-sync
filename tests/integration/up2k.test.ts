import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { up2kChunksize } from '../../src/copyparty/chunksize';
import { CopypartyClient } from '../../src/copyparty/client';
import { nodeFileSource } from '../../src/copyparty/hash.node';
import { Up2kError } from '../../src/copyparty/types';
import { uploadFile } from '../../src/copyparty/up2k';

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

afterAll(() => {
  // No cleanup needed: every test writes to a unique remote folder. The
  // docker volume is wiped via `npm run test:integration:down` between runs.
});

const requireServer = () => {
  if (!serverUp) throw new Error('copyparty not reachable; skipping');
};

describe('uploadFile against copyparty', () => {
  it('uploads a small (sub-chunk) file end-to-end', async () => {
    requireServer();
    await withTempDir(async (dir) => {
      const path = join(dir, 'small.bin');
      const size = 12345;
      await writeRandomFile(path, size, 7);

      const folder = uniqueRemoteFolder('small');
      const client = new CopypartyClient({ baseUrl: COPYPARTY_URL, password: COPYPARTY_PW });

      const result = await uploadFile({
        client,
        fileSource: nodeFileSource,
        localUri: path,
        name: 'small.bin',
        remoteFolder: folder,
        lmod: Math.floor(Date.now() / 1000),
      });

      expect(result.alreadyExisted).toBe(false);
      expect(result.bytesUploaded).toBe(size);
      expect(result.wark).toMatch(/^[A-Za-z0-9_-]+$/);

      // Round-trip check: download the file we just uploaded and compare bytes.
      const downloaded = await downloadFile(folder, result.name);
      const localBytes = await readFile(path);
      expect(downloaded.equals(localBytes)).toBe(true);
    });
  });

  it('uploads a multi-chunk file (3 MiB → 3 chunks at 1 MiB)', async () => {
    requireServer();
    await withTempDir(async (dir) => {
      const path = join(dir, 'multi.bin');
      const size = 3 * MIB + 17; // 4 chunks: 3 full + a 17-byte tail
      await writeRandomFile(path, size, 11);

      const folder = uniqueRemoteFolder('multi');
      const client = new CopypartyClient({ baseUrl: COPYPARTY_URL, password: COPYPARTY_PW });

      const result = await uploadFile({
        client,
        fileSource: nodeFileSource,
        localUri: path,
        name: 'multi.bin',
        remoteFolder: folder,
        lmod: Math.floor(Date.now() / 1000),
      });

      expect(result.alreadyExisted).toBe(false);
      expect(result.bytesUploaded).toBe(size);
      expect(up2kChunksize(size)).toBe(1 * MIB);

      const downloaded = await downloadFile(folder, result.name);
      expect(sha256(downloaded)).toBe(sha256(await readFile(path)));
    });
  });

  it('stitches many chunks across multiple POSTs and round-trips intact', async () => {
    requireServer();
    await withTempDir(async (dir) => {
      const path = join(dir, 'stitch.bin');
      // 12 MiB → 12 chunks @ 1 MiB. The 8-chunk stitch cap splits this into
      // an 8-chunk POST + a 4-chunk POST, exercising multi-batch stitching
      // against the real server. The sha256 round-trip proves the comma-joined
      // body was assembled in the right order.
      const size = 12 * MIB;
      await writeRandomFile(path, size, 53);
      expect(up2kChunksize(size)).toBe(1 * MIB);

      const folder = uniqueRemoteFolder('stitch');
      const client = new CopypartyClient({ baseUrl: COPYPARTY_URL, password: COPYPARTY_PW });

      const result = await uploadFile({
        client,
        fileSource: nodeFileSource,
        localUri: path,
        name: 'stitch.bin',
        remoteFolder: folder,
        lmod: Math.floor(Date.now() / 1000),
      });

      expect(result.alreadyExisted).toBe(false);
      expect(result.bytesUploaded).toBe(size);
      expect(result.dedupSavedBytes).toBe(0);

      const downloaded = await downloadFile(folder, result.name);
      expect(sha256(downloaded)).toBe(sha256(await readFile(path)));
    });
  });

  it('detects dedup on a second upload of the same file', async () => {
    requireServer();
    await withTempDir(async (dir) => {
      const path = join(dir, 'dedup.bin');
      const size = 64 * 1024;
      await writeRandomFile(path, size, 23);

      const folder = uniqueRemoteFolder('dedup');
      const client = new CopypartyClient({ baseUrl: COPYPARTY_URL, password: COPYPARTY_PW });
      const lmod = Math.floor(Date.now() / 1000);

      const first = await uploadFile({
        client,
        fileSource: nodeFileSource,
        localUri: path,
        name: 'dedup.bin',
        remoteFolder: folder,
        lmod,
      });
      expect(first.alreadyExisted).toBe(false);
      expect(first.dedupSavedBytes).toBe(0); // nothing was on the server yet

      const second = await uploadFile({
        client,
        fileSource: nodeFileSource,
        localUri: path,
        name: 'dedup.bin',
        remoteFolder: folder,
        lmod,
      });
      expect(second.alreadyExisted).toBe(true);
      expect(second.bytesUploaded).toBe(0);
      expect(second.dedupSavedBytes).toBe(size); // the whole file was deduped
      expect(second.wark).toBe(first.wark);
    });
  });

  it('resumes when the server already has some chunks', async () => {
    requireServer();
    await withTempDir(async (dir) => {
      const path = join(dir, 'resume.bin');
      const size = 4 * MIB; // 4 chunks at 1 MiB
      await writeRandomFile(path, size, 31);

      const folder = uniqueRemoteFolder('resume');
      const client = new CopypartyClient({ baseUrl: COPYPARTY_URL, password: COPYPARTY_PW });
      const lmod = Math.floor(Date.now() / 1000);
      const chunksize = up2kChunksize(size);
      const hashes = await nodeFileSource.hashFileChunks(path, chunksize);

      // First handshake: upload only the first chunk, then bail.
      const r1 = (await client.handshake(folder, {
        name: 'resume.bin',
        size,
        lmod,
        hash: hashes,
      })) as import('../../src/copyparty/types').HandshakeResponse;
      expect(r1.hash.length).toBe(hashes.length);

      const firstHash = hashes[0];
      const firstChunk = await nodeFileSource.readRange(path, 0, chunksize);
      await client.uploadChunk(r1.purl ?? folder, { hash: firstHash, wark: r1.wark }, firstChunk);

      // Second pass through uploadFile should skip the chunk we already sent.
      const result = await uploadFile({
        client,
        fileSource: nodeFileSource,
        localUri: path,
        name: 'resume.bin',
        remoteFolder: folder,
        lmod,
        precomputedHashes: hashes,
        precomputedSize: size,
      });

      expect(result.alreadyExisted).toBe(false);
      expect(result.bytesUploaded).toBe(size - chunksize); // 3 chunks left
    });
  });

  it('rejects with 401 when the password is wrong', async () => {
    requireServer();
    await withTempDir(async (dir) => {
      const path = join(dir, 'auth.bin');
      await writeRandomFile(path, 1024, 41);

      const folder = uniqueRemoteFolder('auth');
      const client = new CopypartyClient({ baseUrl: COPYPARTY_URL, password: 'definitely-wrong' });

      await expect(
        uploadFile({
          client,
          fileSource: nodeFileSource,
          localUri: path,
          name: 'auth.bin',
          remoteFolder: folder,
          lmod: Math.floor(Date.now() / 1000),
        }),
      ).rejects.toMatchObject({
        name: 'Up2kError',
        phase: 'handshake',
      });
    });
  });
});

// ---------------------------------------------------------------------------
// helpers local to this test file

async function downloadFile(folder: string, name: string): Promise<Buffer> {
  const url = `${COPYPARTY_URL}${folder.startsWith('/') ? folder : `/${folder}`}${
    folder.endsWith('/') ? '' : '/'
  }${encodeURIComponent(name)}`;
  const res = await fetch(url, { headers: { PW: COPYPARTY_PW } });
  if (!res.ok) {
    throw new Up2kError(`download ${res.status} ${res.statusText} ${url}`, 'finalize', res.status);
  }
  return Buffer.from(await res.arrayBuffer());
}

function sha256(buf: Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}
