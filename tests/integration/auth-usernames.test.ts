/**
 * Coverage for a `--usernames` copyparty, which is what most real deployments
 * run. On such a server the `PW:` header alone is rejected — the client has to
 * send HTTP Basic auth (see `headers()` in src/copyparty/client.ts). Its
 * password-only sibling is covered by test-connection.test.ts against :3923.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { CopypartyClient } from '../../src/copyparty/client';

import { COPYPARTY_PW, COPYPARTY_USER, COPYPARTY_USERNAMES_URL } from './helpers';

let serverUp = false;

beforeAll(async () => {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2000);
    const res = await fetch(`${COPYPARTY_USERNAMES_URL}/`, { signal: ctrl.signal });
    clearTimeout(t);
    serverUp = res.ok || res.status === 401;
  } catch {
    serverUp = false;
  }
  if (!serverUp) {
    console.warn(
      `\n[integration] --usernames copyparty not reachable at ${COPYPARTY_USERNAMES_URL}; ` +
        'start it with: npm run test:integration:up\n',
    );
  }
});

describe('auth against a --usernames server', () => {
  it('authenticates with username + password via HTTP Basic', async () => {
    expect(serverUp).toBe(true);
    const client = new CopypartyClient({
      baseUrl: COPYPARTY_USERNAMES_URL,
      username: COPYPARTY_USER,
      password: COPYPARTY_PW,
    });

    const listing = await client.listFolder('/');
    expect(listing.acct).toBe(COPYPARTY_USER);
  });

  it('stays anonymous when the password is sent without a username', async () => {
    expect(serverUp).toBe(true);
    const client = new CopypartyClient({
      baseUrl: COPYPARTY_USERNAMES_URL,
      password: COPYPARTY_PW,
    });

    // Without a username the client sends the `PW:` header, which a --usernames
    // server ignores. Note it answers 200 rather than 401 — you get an empty,
    // permission-less anonymous view, so "the request succeeded" is not the
    // same as "auth worked". This is why the app must send Basic auth.
    const listing = await client.listFolder('/');
    expect(listing.acct).toBe('*');
    expect(listing.perms).toEqual([]);
  });
});
