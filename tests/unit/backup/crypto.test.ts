import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  decryptBundle,
  encryptBundle,
  isEncryptedEnvelope,
} from '@/src/backup/crypto';

const rng = (n: number) => new Uint8Array(randomBytes(n));

describe('backup crypto', () => {
  it('round-trips plaintext through encrypt/decrypt', async () => {
    const plaintext = JSON.stringify({ hello: 'wörld', n: 42 });
    const envelope = await encryptBundle(plaintext, 'correct horse', rng);
    expect(isEncryptedEnvelope(envelope)).toBe(true);
    const out = await decryptBundle(envelope, 'correct horse');
    expect(out).toBe(plaintext);
  });

  it('does not leak plaintext into the envelope', async () => {
    const envelope = await encryptBundle('super-secret-password', 'pp', rng);
    expect(envelope).not.toContain('super-secret-password');
  });

  it('fails with the wrong passphrase', async () => {
    const envelope = await encryptBundle('data', 'right', rng);
    await expect(decryptBundle(envelope, 'wrong')).rejects.toThrow(
      /incorrect passphrase|corrupted/i,
    );
  });

  it('detects tampering via the AEAD tag', async () => {
    const envelope = await encryptBundle('data', 'pp', rng);
    const obj = JSON.parse(envelope);
    // flip a byte of the ciphertext
    const ctBytes = Buffer.from(obj.ct, 'base64');
    ctBytes[0] ^= 0xff;
    obj.ct = ctBytes.toString('base64');
    await expect(decryptBundle(JSON.stringify(obj), 'pp')).rejects.toThrow();
  });

  it('requires a passphrase to encrypt', async () => {
    await expect(encryptBundle('data', '', rng)).rejects.toThrow(/passphrase/i);
  });

  it('isEncryptedEnvelope is false for a plaintext bundle', () => {
    expect(isEncryptedEnvelope(JSON.stringify({ format: 'something' }))).toBe(
      false,
    );
    expect(isEncryptedEnvelope('not json')).toBe(false);
  });
});
