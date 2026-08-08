import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const COPYPARTY_URL = process.env.COPYPARTY_URL ?? 'http://127.0.0.1:3923';
export const COPYPARTY_USER = process.env.COPYPARTY_USER ?? 'test';
export const COPYPARTY_PW = process.env.COPYPARTY_PW ?? 'testpw';

/** The `--usernames` server from docker-compose (HTTP Basic auth required). */
export const COPYPARTY_USERNAMES_URL =
  process.env.COPYPARTY_USERNAMES_URL ?? 'http://127.0.0.1:3924';

/**
 * Host side of the compose `./seed-data:/w/_seed` mount, and the copyparty path
 * it appears at. Lets a test drop a file onto the server's filesystem the way a
 * user's rsync/cp would — bypassing up2k entirely — so we can then assert that
 * uploading the same bytes dedups against it.
 */
export const COPYPARTY_SEED_DIR =
  process.env.COPYPARTY_SEED_DIR ?? resolve(__dirname, '../seed-data');
export const COPYPARTY_SEED_REMOTE = process.env.COPYPARTY_SEED_REMOTE ?? '/_seed';

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

/**
 * Salt mixed into every `writeRandomFile` seed.
 *
 * Fixtures must stay deterministic WITHIN a run (the dedup test writes the same
 * bytes twice and expects the second upload to dedup) but differ ACROSS runs:
 * the `copyparty-data` volume persists, so with `--dedup` on, run N+1 would
 * dedup against run N's leftovers and tests that expect a fresh upload would
 * fail. Set COPYPARTY_TEST_SALT to reproduce a specific run's fixtures.
 *
 * globalSetup pins one value for all worker forks (see vitest.integration.config.ts).
 */
const RUN_SALT = (Number(process.env.COPYPARTY_TEST_SALT) || Date.now()) | 0;

/** Write `size` bytes of pseudo-random (deterministic per `seed`) data. */
export async function writeRandomFile(path: string, size: number, seed = 1): Promise<void> {
  // xorshift32 — fast, deterministic, no Math.random global state
  let s = (seed ^ RUN_SALT) | 0 || 1;
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

/** True when the compose seed mount is present (false if the suite is pointed
 *  at a server we don't share a filesystem with). */
export async function seedDirAvailable(): Promise<boolean> {
  try {
    await mkdir(COPYPARTY_SEED_DIR, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Drop `bytes` onto the server's filesystem at `<seed>/relPath`, bypassing
 * up2k. Returns the copyparty path it will appear at once indexed.
 */
export async function seedServerFile(relPath: string, bytes: Buffer): Promise<string> {
  const abs = join(COPYPARTY_SEED_DIR, relPath);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, bytes);
  return `${COPYPARTY_SEED_REMOTE}/${relPath}`;
}

/** Remove a seeded path from the host side. */
export async function removeSeed(relPath: string): Promise<void> {
  await rm(join(COPYPARTY_SEED_DIR, relPath), { recursive: true, force: true });
}

/**
 * Block until copyparty's up2k index knows about a file with these chunk
 * hashes, using a search-only (`srch`) handshake.
 *
 * Synchronising on the index rather than on a fixed sleep is what makes the
 * dedup tests deterministic: it doesn't matter whether the file was picked up
 * by --re-maxage, a startup scan, or an explicit rescan.
 */
export async function waitForIndexed(
  hashes: string[],
  size: number,
  opts: { baseUrl?: string; password?: string; timeoutMs?: number } = {},
): Promise<boolean> {
  const baseUrl = opts.baseUrl ?? COPYPARTY_URL;
  const password = opts.password ?? COPYPARTY_PW;
  const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', PW: password },
        body: JSON.stringify({
          name: 'probe.bin',
          size,
          lmod: Math.floor(Date.now() / 1000),
          hash: hashes,
          srch: 1,
        }),
      });
      if (res.ok) {
        const body = (await res.json()) as { hits?: unknown[] };
        if (body.hits && body.hits.length > 0) return true;
      }
    } catch {
      // Server still starting, or nothing indexed yet — keep polling.
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}
