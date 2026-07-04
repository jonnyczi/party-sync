import { afterEach, describe, expect, it, vi } from 'vitest';

import { CopypartyClient } from '../../src/copyparty/client';

function okLs(): Response {
  return new Response(JSON.stringify({ acct: 'test', perms: ['read'], files: [], dirs: [] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** Pull the PW header out of the most recent fetch call. */
function pwHeader(fetchMock: ReturnType<typeof vi.fn>): string | undefined {
  const init = fetchMock.mock.calls.at(-1)?.[1] as RequestInit | undefined;
  return (init?.headers as Record<string, string> | undefined)?.['PW'];
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CopypartyClient PW header', () => {
  it('sends the bare password when no username is set', async () => {
    const fetchMock = vi.fn(async () => okLs());
    vi.stubGlobal('fetch', fetchMock);
    await new CopypartyClient({ baseUrl: 'http://h', password: 'pw' }).listFolder('/');
    expect(pwHeader(fetchMock)).toBe('pw');
  });

  it('sends username:password when a username is set (--usernames servers)', async () => {
    const fetchMock = vi.fn(async () => okLs());
    vi.stubGlobal('fetch', fetchMock);
    await new CopypartyClient({
      baseUrl: 'http://h',
      password: '123',
      username: 'jonnyczi',
    }).listFolder('/');
    expect(pwHeader(fetchMock)).toBe('jonnyczi:123');
  });

  it('ignores a blank/whitespace username (no leading-colon credential)', async () => {
    const fetchMock = vi.fn(async () => okLs());
    vi.stubGlobal('fetch', fetchMock);
    await new CopypartyClient({
      baseUrl: 'http://h',
      password: 'pw',
      username: '   ',
    }).listFolder('/');
    expect(pwHeader(fetchMock)).toBe('pw');
  });

  it('omits the PW header entirely when there is no password', async () => {
    const fetchMock = vi.fn(async () => okLs());
    vi.stubGlobal('fetch', fetchMock);
    await new CopypartyClient({ baseUrl: 'http://h', username: 'jonnyczi' }).listFolder('/');
    expect(pwHeader(fetchMock)).toBeUndefined();
  });
});
