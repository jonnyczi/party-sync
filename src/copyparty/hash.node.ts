import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';

import { CHUNK_HASH_BYTES, bufToB64Url } from './b64url';
import type { FileSource } from './hash';

class NodeFileSource implements FileSource {
  async hashFileChunks(path: string, chunksize: number): Promise<string[]> {
    const fh = await open(path, 'r');
    try {
      const { size } = await fh.stat();
      const out: string[] = [];
      const buf = Buffer.allocUnsafe(chunksize);
      for (let car = 0; car < size; car += chunksize) {
        const want = Math.min(chunksize, size - car);
        const { bytesRead } = await fh.read(buf, 0, want, car);
        if (bytesRead !== want) {
          throw new Error(`short read at offset ${car}: got ${bytesRead}, expected ${want}`);
        }
        const digest = createHash('sha512').update(buf.subarray(0, want)).digest();
        out.push(
          bufToB64Url(new Uint8Array(digest.buffer, digest.byteOffset, CHUNK_HASH_BYTES)),
        );
      }
      return out;
    } finally {
      await fh.close();
    }
  }

  async readRange(path: string, car: number, cdr: number): Promise<Uint8Array> {
    const fh = await open(path, 'r');
    try {
      const len = cdr - car;
      const buf = Buffer.allocUnsafe(len);
      const { bytesRead } = await fh.read(buf, 0, len, car);
      if (bytesRead !== len) {
        throw new Error(`short read at offset ${car}: got ${bytesRead}, expected ${len}`);
      }
      return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead);
    } finally {
      await fh.close();
    }
  }

  async size(path: string): Promise<number> {
    return (await stat(path)).size;
  }
}

export const nodeFileSource: FileSource = new NodeFileSource();
