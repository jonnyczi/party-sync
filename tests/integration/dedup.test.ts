/**
 * Server-side content dedup, against a copyparty that indexes (`-e2dsa`) and
 * dedups (`--dedup`) — i.e. how people actually run it.
 *
 * The scenario these cover is the one that bit us: files that reached the
 * server by some route other than this client (rsync, cp, another device), then
 * got indexed. copyparty dedups purely on the wark, which is derived from the
 * chunk hashes — so if what we upload differs from what's on disk by even one
 * byte, dedup silently can't fire and copyparty stores a renamed duplicate. The
 * one-byte test pins that signature, because a real bug produced exactly it:
 * Android was zero-filling the EXIF GPS block on read, preserving file length.
 */
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { up2kChunksize } from '../../src/copyparty/chunksize';
import { CopypartyClient } from '../../src/copyparty/client';
import { nodeFileSource } from '../../src/copyparty/hash.node';
import { uploadFile } from '../../src/copyparty/up2k';

import {
  COPYPARTY_PW,
  COPYPARTY_URL,
  copypartyReachable,
  removeSeed,
  seedDirAvailable,
  seedServerFile,
  uniqueRemoteFolder,
  waitForIndexed,
  withTempDir,
} from './helpers';
import { writeFile } from 'node:fs/promises';

const SIZE = 3 * 1024 * 1024 + 777; // spans 4 chunks at the 1 MiB chunksize

let ready = false;
const seeded: string[] = [];

beforeAll(async () => {
  ready = (await copypartyReachable()) && (await seedDirAvailable());
  if (!ready) {
    console.warn(
      '\n[integration] dedup suite needs the dockerized copyparty and its ' +
        './seed-data mount; start it with: npm run test:integration:up\n',
    );
  }
});

afterAll(async () => {
  for (const rel of seeded) await removeSeed(rel);
});

const client = () => new CopypartyClient({ baseUrl: COPYPARTY_URL, password: COPYPARTY_PW });

const hashesOf = async (path: string, size: number) =>
  nodeFileSource.hashFileChunks(path, up2kChunksize(size));

/** Seed `bytes` onto the server's filesystem and wait for the index to see it. */
async function seedAndIndex(rel: string, bytes: Buffer, localPath: string) {
  seeded.push(rel.split('/')[0]);
  await seedServerFile(rel, bytes);
  await writeFile(localPath, bytes);
  const hashes = await hashesOf(localPath, bytes.byteLength);
  const indexed = await waitForIndexed(hashes, bytes.byteLength);
  expect(indexed, 'copyparty did not index the seeded file in time').toBe(true);
  return hashes;
}

describe('content dedup against an indexed copyparty', () => {
  it('dedups a file that reached the server out-of-band', async () => {
    expect(ready).toBe(true);
    await withTempDir(async (dir) => {
      const bytes = randomBytes(SIZE);
      const local = join(dir, 'photo.jpg');
      const rel = `${uniqueRemoteFolder('oob').slice(1, -1)}/photo.jpg`;
      await seedAndIndex(rel, bytes, local);

      // Upload the identical bytes to a DIFFERENT folder: dedup is content-
      // addressed, so location must not matter.
      const result = await uploadFile({
        client: client(),
        fileSource: nodeFileSource,
        localUri: local,
        name: 'photo.jpg',
        remoteFolder: uniqueRemoteFolder('upload'),
        lmod: Math.floor(Date.now() / 1000),
      });

      expect(result.alreadyExisted).toBe(true);
      expect(result.bytesUploaded).toBe(0);
      expect(result.dedupSavedBytes).toBe(SIZE);
      expect(result.name).toBe('photo.jpg');
    });
  });

  it('re-uploads and gets renamed when one byte differs at identical size', async () => {
    expect(ready).toBe(true);
    await withTempDir(async (dir) => {
      const bytes = randomBytes(SIZE);
      const seedLocal = join(dir, 'seed.jpg');
      const folderName = uniqueRemoteFolder('collide').slice(1, -1);
      await seedAndIndex(`${folderName}/photo.jpg`, bytes, seedLocal);

      // Same length, a few bytes zeroed in place — exactly what Android's EXIF
      // location redaction does to a photo read through MediaStore.
      const altered = Buffer.from(bytes);
      altered.fill(0, 1000, 1064);
      const local = join(dir, 'altered.jpg');
      await writeFile(local, altered);

      const result = await uploadFile({
        client: client(),
        fileSource: nodeFileSource,
        localUri: local,
        name: 'photo.jpg',
        remoteFolder: `/_seed/${folderName}/`,
        lmod: Math.floor(Date.now() / 1000),
      });

      expect(result.alreadyExisted).toBe(false);
      expect(result.bytesUploaded).toBe(SIZE);
      // copyparty's collision rename: <name>-<unixtime.micros>-<rand>.<ext>
      expect(result.name).not.toBe('photo.jpg');
      expect(result.name).toMatch(/^photo\.jpg-\d+\.\d+-\S+\.jpg$/);
    });
  });

  it('dedups across folders within the same volume', async () => {
    expect(ready).toBe(true);
    await withTempDir(async (dir) => {
      const bytes = randomBytes(SIZE);
      const local = join(dir, 'photo.jpg');
      const rel = `${uniqueRemoteFolder('xfolder').slice(1, -1)}/deep/nested/photo.jpg`;
      await seedAndIndex(rel, bytes, local);

      // Mirrors real usage: the photo sits under /photos on the server, the app
      // uploads to /phone-backups/<date>/.
      const result = await uploadFile({
        client: client(),
        fileSource: nodeFileSource,
        localUri: local,
        name: 'IMG_0001.jpg',
        remoteFolder: uniqueRemoteFolder('phone-backups'),
        lmod: Math.floor(Date.now() / 1000),
      });

      expect(result.alreadyExisted).toBe(true);
      expect(result.bytesUploaded).toBe(0);
    });
  });
});
