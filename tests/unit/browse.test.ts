import { afterEach, describe, expect, it, vi } from 'vitest';

import { browseFolder } from '../../src/copyparty/browse';
import { childPath, normalizeRemotePath, parentPath } from '../../src/copyparty/paths';

function lsResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('browseFolder', () => {
  it('decodes dir hrefs, strips trailing slashes, and drops files', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        lsResponse({
          acct: 'test',
          perms: ['read', 'write'],
          files: [{ href: 'note.txt', sz: 1, ts: 0 }],
          dirs: [
            { href: 'My%20Pics/', sz: 0, ts: 0 },
            { href: 'docs/', sz: 0, ts: 0 },
          ],
        }),
      ),
    );

    const res = await browseFolder({ baseUrl: 'http://h', password: 'pw', path: '/' });
    expect(res.dirs).toEqual(['My Pics', 'docs']);
    expect(res.writable).toBe(true);
    expect(res.acct).toBe('test');
  });

  it('reports writable:false when perms lack write', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => lsResponse({ acct: 'test', perms: ['read'], files: [], dirs: [] })),
    );
    const res = await browseFolder({ baseUrl: 'http://h', password: 'pw', path: '/ro' });
    expect(res.writable).toBe(false);
  });

  it('throws an auth error when a password is supplied but acct is anonymous', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => lsResponse({ acct: '*', perms: ['read'], files: [], dirs: [] })),
    );
    await expect(
      browseFolder({ baseUrl: 'http://h', password: 'wrong', path: '/' }),
    ).rejects.toMatchObject({ kind: 'auth' });
  });

  it('maps a 404 to a not_found error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
    await expect(
      browseFolder({ baseUrl: 'http://h', path: '/missing' }),
    ).rejects.toMatchObject({ kind: 'not_found' });
  });
});

describe('path helpers', () => {
  it('childPath appends a name, normalizing the parent slash', () => {
    expect(childPath('/a', 'b')).toBe('/a/b');
    expect(childPath('/', 'b')).toBe('/b');
    expect(childPath('/a/', 'b')).toBe('/a/b');
  });

  it('parentPath clamps at root', () => {
    expect(parentPath('/a/b')).toBe('/a');
    expect(parentPath('/a')).toBe('/');
    expect(parentPath('/')).toBe('/');
    expect(parentPath('/a/b/')).toBe('/a');
  });

  it('normalizeRemotePath trims, adds a leading slash, and strips trailing ones', () => {
    expect(normalizeRemotePath('  photos/ ')).toBe('/photos');
    expect(normalizeRemotePath('')).toBe('');
    expect(normalizeRemotePath('/')).toBe('/');
    expect(normalizeRemotePath('a/b/')).toBe('/a/b');
  });
});
