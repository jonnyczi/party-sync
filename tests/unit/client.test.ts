import { afterEach, describe, expect, it, vi } from 'vitest';

import { base64ToBytes } from '../../src/backup/base64';
import { CopypartyClient } from '../../src/copyparty/client';

function okLs(): Response {
  return new Response(JSON.stringify({ acct: 'test', perms: ['read'], files: [], dirs: [] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function lastHeaders(
  fetchMock: ReturnType<typeof vi.fn>,
): Record<string, string> | undefined {
  const init = fetchMock.mock.calls.at(-1)?.[1] as RequestInit | undefined;
  return init?.headers as Record<string, string> | undefined;
}

/** Pull the PW header out of the most recent fetch call. */
function pwHeader(fetchMock: ReturnType<typeof vi.fn>): string | undefined {
  return lastHeaders(fetchMock)?.['PW'];
}

/** Pull the Authorization header out of the most recent fetch call. */
function authHeader(fetchMock: ReturnType<typeof vi.fn>): string | undefined {
  return lastHeaders(fetchMock)?.['Authorization'];
}

/** Decode an `Authorization: Basic <b64>` header back to its `user:pass`. */
function decodeBasic(header: string | undefined): string {
  const b64 = (header ?? '').replace(/^Basic /, '');
  return new TextDecoder().decode(base64ToBytes(b64));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CopypartyClient auth header', () => {
  it('sends the bare PW header when no username is set', async () => {
    const fetchMock = vi.fn(async () => okLs());
    vi.stubGlobal('fetch', fetchMock);
    await new CopypartyClient({ baseUrl: 'http://h', password: 'pw' }).listFolder('/');
    expect(pwHeader(fetchMock)).toBe('pw');
    expect(authHeader(fetchMock)).toBeUndefined();
  });

  it('sends HTTP Basic auth (not PW) when a username is set', async () => {
    const fetchMock = vi.fn(async () => okLs());
    vi.stubGlobal('fetch', fetchMock);
    await new CopypartyClient({
      baseUrl: 'http://h',
      password: '123',
      username: 'jonnyczi',
    }).listFolder('/');
    // No verbatim PW header (which a non---usernames server would 403).
    expect(pwHeader(fetchMock)).toBeUndefined();
    expect(authHeader(fetchMock)).toMatch(/^Basic [A-Za-z0-9+/=]+$/);
    expect(decodeBasic(authHeader(fetchMock))).toBe('jonnyczi:123');
  });

  it('UTF-8 encodes non-ASCII credentials in the Basic header', async () => {
    const fetchMock = vi.fn(async () => okLs());
    vi.stubGlobal('fetch', fetchMock);
    await new CopypartyClient({
      baseUrl: 'http://h',
      password: 'pä$$',
      username: 'jönny',
    }).listFolder('/');
    expect(decodeBasic(authHeader(fetchMock))).toBe('jönny:pä$$');
  });

  it('ignores a blank/whitespace username (bare PW, no Authorization)', async () => {
    const fetchMock = vi.fn(async () => okLs());
    vi.stubGlobal('fetch', fetchMock);
    await new CopypartyClient({
      baseUrl: 'http://h',
      password: 'pw',
      username: '   ',
    }).listFolder('/');
    expect(pwHeader(fetchMock)).toBe('pw');
    expect(authHeader(fetchMock)).toBeUndefined();
  });

  it('omits all auth headers when there is no password', async () => {
    const fetchMock = vi.fn(async () => okLs());
    vi.stubGlobal('fetch', fetchMock);
    await new CopypartyClient({ baseUrl: 'http://h', username: 'jonnyczi' }).listFolder('/');
    expect(pwHeader(fetchMock)).toBeUndefined();
    expect(authHeader(fetchMock)).toBeUndefined();
  });
});
