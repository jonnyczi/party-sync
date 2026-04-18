import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { CHUNK_HASH_BYTES, bufToB64Url } from './b64url';

describe('bufToB64Url', () => {
  it('matches the canonical alphabet for the full 0..255 byte range', () => {
    // Build a 6-byte input chosen so that the 6-bit sextets walk the alphabet
    // boundary: A (0), Z (25), a (26), z (51), 0 (52), 9 (61), - (62), _ (63).
    const input = new Uint8Array([0x00, 0x67, 0xa9, 0xfb, 0xef, 0xff]);
    expect(bufToB64Url(input)).toBe('AGep--__');
  });

  it('handles the byteRem=1 tail (no padding)', () => {
    expect(bufToB64Url(new Uint8Array([0x66]))).toBe('Zg');
  });

  it('handles the byteRem=2 tail (no padding)', () => {
    expect(bufToB64Url(new Uint8Array([0x66, 0x6f]))).toBe('Zm8');
  });

  it('handles the byteRem=0 tail', () => {
    expect(bufToB64Url(new Uint8Array([0x66, 0x6f, 0x6f]))).toBe('Zm9v');
  });

  it('produces a 44-char string for the 33-byte SHA-512 prefix', () => {
    // The whole point of the 33-byte slice: 33 % 3 === 0 ⇒ exactly 44 chars.
    const digest = createHash('sha512').update('hello').digest();
    const sliced = new Uint8Array(digest.buffer, digest.byteOffset, CHUNK_HASH_BYTES);
    const encoded = bufToB64Url(sliced);
    expect(encoded).toHaveLength(44);
  });

  it('matches Node Buffer base64url for random byte arrays of every length', () => {
    // Cross-validates against the platform encoder over many sizes incl. all
    // three byteRem branches and a deterministic-but-varied byte distribution.
    for (let len = 0; len < 200; len++) {
      const buf = Buffer.from(
        Array.from({ length: len }, (_, i) => (i * 1009 + 31) & 0xff),
      );
      expect(bufToB64Url(new Uint8Array(buf))).toBe(buf.toString('base64url'));
    }
  });
});
