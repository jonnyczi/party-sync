import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const COPYPARTY_URL = process.env.COPYPARTY_URL ?? 'http://127.0.0.1:3923';
export const COPYPARTY_USER = process.env.COPYPARTY_USER ?? 'test';
export const COPYPARTY_PW = process.env.COPYPARTY_PW ?? 'testpw';

/** True if a copyparty server is reachable at COPYPARTY_URL. */
export async function copypartyReachable(): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(`${COPYPARTY_URL}/?reset=/._`, { signal: ctrl.signal });
    clearTimeout(t);
    return res.ok || res.status === 401;
  } catch {
    return false;
  }
}

/**
 * Make a temp dir, run `body`, then tear it down. Returns whatever `body`
 * returned. Use this to keep test fixtures fully isolated.
 */
export async function withTempDir<T>(body: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'copyparty-it-'));
  try {
    return await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Write `size` bytes of pseudo-random (deterministic per `seed`) data. */
export async function writeRandomFile(path: string, size: number, seed = 1): Promise<void> {
  // xorshift32 — fast, deterministic, no Math.random global state
  let s = seed | 0 || 1;
  const buf = Buffer.allocUnsafe(size);
  for (let i = 0; i < size; i++) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    buf[i] = s & 0xff;
  }
  await writeFile(path, buf);
}

export function uniqueRemoteFolder(prefix: string): string {
  return `/${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}/`;
}
