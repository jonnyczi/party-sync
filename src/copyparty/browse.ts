import { CopypartyClient } from './client';
import { mapError, TestConnectionError } from './test-connection';

export interface BrowseResult {
  /** Folder names directly under the requested path (decoded, no trailing slash). */
  dirs: string[];
  /** Whether the authenticated user may upload into the requested path. */
  writable: boolean;
  /** Username the request authenticated as, or '*' for anonymous. */
  acct: string;
}

/**
 * List the subfolders of a remote path for the server browser. Thin wrapper over
 * {@link CopypartyClient.listFolder} that returns only what the picker needs and
 * maps failures onto the same {@link TestConnectionError} taxonomy the
 * "Test connection" buttons use, so error wording stays consistent.
 *
 * Files are intentionally dropped — the browser navigates folders only.
 */
export async function browseFolder(opts: {
  baseUrl: string;
  password?: string;
  /** Account name; sent via HTTP Basic auth when set (see CopypartyClient). */
  username?: string | null;
  path: string;
}): Promise<BrowseResult> {
  const client = new CopypartyClient({
    baseUrl: opts.baseUrl,
    password: opts.password,
    username: opts.username ?? undefined,
  });

  let resp;
  try {
    resp = await client.listFolder(opts.path);
  } catch (e) {
    throw mapError(e, opts.path);
  }

  // copyparty answers ?ls with 200 + acct:'*' (anonymous) when the PW header is
  // wrong/missing rather than 401 — mirror the Test-connection auth check.
  if (opts.password && resp.acct === '*') {
    throw new TestConnectionError(
      'Authentication failed. Check username/password.',
      'auth',
    );
  }

  const dirs = resp.dirs.map((d) => safeDecode(d.href.replace(/\/+$/, '')));
  return {
    dirs,
    writable: resp.perms?.includes('write') ?? false,
    acct: resp.acct,
  };
}

/** decodeURIComponent that tolerates malformed escape sequences. */
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
