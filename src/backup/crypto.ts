import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { scryptAsync } from '@noble/hashes/scrypt';

import { base64ToBytes, bytesToBase64 } from './base64';

// Passphrase-based encryption for backup bundles. scrypt (KDF) +
// XChaCha20-Poly1305 (AEAD), both from the audited, pure-JS @noble libraries so
// the same code runs in Hermes and under vitest with no native dependency.
//
// Random bytes (salt + nonce) are supplied by the caller (`RandomBytes`) — at
// runtime from expo-crypto, in tests from a deterministic/Node source — so this
// module needs no global crypto.

export type RandomBytes = (n: number) => Uint8Array;

const ENC_FORMAT = 'copyparty-client-backup-enc' as const;
const ENC_VERSION = 1 as const;
const SALT_LEN = 16;
const NONCE_LEN = 24; // XChaCha20 nonce
const KEY_LEN = 32;
// scrypt cost: ~tens of ms on a modern phone, tunable via the envelope.
const SCRYPT = { N: 1 << 15, r: 8, p: 1 } as const;

interface EncEnvelope {
  format: typeof ENC_FORMAT;
  version: typeof ENC_VERSION;
  kdf: 'scrypt';
  N: number;
  r: number;
  p: number;
  dkLen: number;
  salt: string;
  nonce: string;
  ct: string;
}

function utf8ToBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function bytesToUtf8(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}

async function deriveKey(
  passphrase: string,
  salt: Uint8Array,
  N: number,
  r: number,
  p: number,
  dkLen: number,
): Promise<Uint8Array> {
  return scryptAsync(utf8ToBytes(passphrase.normalize('NFKC')), salt, {
    N,
    r,
    p,
    dkLen,
  });
}

/** Encrypt a plaintext bundle string; returns the JSON envelope to store. */
export async function encryptBundle(
  plaintext: string,
  passphrase: string,
  rng: RandomBytes,
): Promise<string> {
  if (!passphrase) throw new Error('A passphrase is required to encrypt.');
  const salt = rng(SALT_LEN);
  const nonce = rng(NONCE_LEN);
  const key = await deriveKey(
    passphrase,
    salt,
    SCRYPT.N,
    SCRYPT.r,
    SCRYPT.p,
    KEY_LEN,
  );
  const ct = xchacha20poly1305(key, nonce).encrypt(utf8ToBytes(plaintext));
  const envelope: EncEnvelope = {
    format: ENC_FORMAT,
    version: ENC_VERSION,
    kdf: 'scrypt',
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    dkLen: KEY_LEN,
    salt: bytesToBase64(salt),
    nonce: bytesToBase64(nonce),
    ct: bytesToBase64(ct),
  };
  return JSON.stringify(envelope);
}

/** Detect an encrypted envelope without throwing. */
export function isEncryptedEnvelope(text: string): boolean {
  try {
    const obj = JSON.parse(text) as Record<string, unknown>;
    return obj?.format === ENC_FORMAT;
  } catch {
    return false;
  }
}

/** Decrypt an envelope back to the plaintext bundle string. */
export async function decryptBundle(
  envelopeText: string,
  passphrase: string,
): Promise<string> {
  let obj: EncEnvelope;
  try {
    obj = JSON.parse(envelopeText) as EncEnvelope;
  } catch {
    throw new Error('This encrypted backup is not valid JSON.');
  }
  if (obj.format !== ENC_FORMAT) {
    throw new Error('This is not an encrypted copyparty-client backup.');
  }
  if (obj.kdf !== 'scrypt') {
    throw new Error(`Unsupported key derivation: ${String(obj.kdf)}.`);
  }
  const salt = base64ToBytes(obj.salt);
  const nonce = base64ToBytes(obj.nonce);
  const ct = base64ToBytes(obj.ct);
  const key = await deriveKey(
    passphrase,
    salt,
    obj.N,
    obj.r,
    obj.p,
    obj.dkLen || KEY_LEN,
  );
  try {
    const pt = xchacha20poly1305(key, nonce).decrypt(ct);
    return bytesToUtf8(pt);
  } catch {
    throw new Error('Incorrect passphrase or corrupted backup file.');
  }
}
