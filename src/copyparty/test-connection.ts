import { CopypartyClient } from './client';
import { Up2kError } from './types';

/**
 * Pre-flight validation used by the "Test connection" buttons on the Server
 * and Job config screens. Each function resolves on success and throws
 * {@link TestConnectionError} on any failure, with a user-facing `message`
 * suitable for `Alert.alert`.
 *
 * Note on TLS pinning: the app stores `cert_sha256` but does not yet enforce
 * it at the fetch layer; this helper reflects the same platform-fetch
 * behavior the real sync path uses. Wiring true pinning is a separate task.
 */

export type TestConnectionKind =
  | 'unreachable'
  | 'auth'
  | 'forbidden'
  | 'not_found'
  | 'http'
  | 'read_only'
  | 'local_lost'
  | 'unknown';

export class TestConnectionError extends Error {
  constructor(
    message: string,
    public readonly kind: TestConnectionKind,
  ) {
    super(message);
    this.name = 'TestConnectionError';
  }
}

export interface TestServerOptions {
  baseUrl: string;
  password: string;
  certSha256?: string | null;
}

export interface TestJobOptions extends TestServerOptions {
  remotePath: string;
  /** SAF tree URI — only meaningful when sourceKind === 'saf'. */
  sourceUri?: string;
  /** When 'media', local check asks for MediaLibrary permission instead of probing SAF. */
  sourceKind?: 'saf' | 'media';
}

export async function testServerConnection(opts: TestServerOptions): Promise<void> {
  const client = new CopypartyClient({
    baseUrl: opts.baseUrl,
    password: opts.password,
  });
  let resp;
  try {
    resp = await client.listFolder('/');
  } catch (e) {
    throw mapError(e, '/');
  }
  // copyparty returns 200 with acct:'*' (anonymous) when the PW header is
  // wrong or missing — it never 401s on ?ls. A password was supplied, so a
  // `*` acct means the server didn't accept it.
  if (opts.password && resp.acct === '*') {
    throw new TestConnectionError(
      'Authentication failed. Check username/password.',
      'auth',
    );
  }
}

export async function testJobConnection(
  opts: TestJobOptions,
): Promise<{ remoteOk: true; localOk: boolean }> {
  const client = new CopypartyClient({
    baseUrl: opts.baseUrl,
    password: opts.password,
  });
  let resp;
  try {
    resp = await client.listFolder(opts.remotePath);
  } catch (e) {
    throw mapError(e, opts.remotePath);
  }
  if (opts.password && resp.acct === '*') {
    throw new TestConnectionError(
      'Authentication failed. Check username/password.',
      'auth',
    );
  }
  if (!resp.perms?.includes('write')) {
    throw new TestConnectionError(
      `Read-only access to ${opts.remotePath}. Uploads will fail.`,
      'read_only',
    );
  }
  let localOk = true;
  if (opts.sourceKind === 'media') {
    localOk = await probeMediaLibrary();
  } else if (opts.sourceUri) {
    localOk = await probeSaf(opts.sourceUri);
  }
  return { remoteOk: true, localOk };
}

export function mapError(e: unknown, remotePath: string): TestConnectionError {
  if (e instanceof Up2kError && typeof e.httpStatus === 'number') {
    const s = e.httpStatus;
    if (s === 401)
      return new TestConnectionError(
        'Authentication failed. Check username/password.',
        'auth',
      );
    if (s === 403)
      return new TestConnectionError(
        `Access denied for ${remotePath}.`,
        'forbidden',
      );
    if (s === 404)
      return new TestConnectionError(
        `Remote path not found: ${remotePath}.`,
        'not_found',
      );
    return new TestConnectionError(
      `Server error (HTTP ${s}). Try again later.`,
      'http',
    );
  }
  // TypeError (fetch network failure), AbortError, DNS failure, etc.
  return new TestConnectionError(
    'Server unreachable. Check the URL and your network.',
    'unreachable',
  );
}

async function probeSaf(sourceUri: string): Promise<boolean> {
  try {
    // Lazy-require so this file can be imported in Node (vitest) without
    // pulling in expo-file-system's native module.
    const mod = await import('expo-file-system/legacy');
    await mod.StorageAccessFramework.readDirectoryAsync(sourceUri);
    return true;
  } catch {
    return false;
  }
}

async function probeMediaLibrary(): Promise<boolean> {
  try {
    // Lazy-require for the same reason as probeSaf.
    const mod = await import('expo-media-library');
    const perm = await mod.getPermissionsAsync(false, ['photo', 'video']);
    return perm.status === 'granted';
  } catch {
    return false;
  }
}
