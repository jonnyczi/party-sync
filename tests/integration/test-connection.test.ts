import { beforeAll, describe, expect, it } from 'vitest';

import { CopypartyClient } from '../../src/copyparty/client';
import {
  TestConnectionError,
  testJobConnection,
  testServerConnection,
} from '../../src/copyparty/test-connection';

import {
  COPYPARTY_PW,
  COPYPARTY_URL,
  COPYPARTY_USER,
  copypartyReachable,
  uniqueRemoteFolder,
} from './helpers';

let serverUp = false;

beforeAll(async () => {
  serverUp = await copypartyReachable();
  if (!serverUp) {
    console.warn(
      `\n[integration] copyparty not reachable at ${COPYPARTY_URL}; ` +
        `start it with: npm run test:integration:up\n`,
    );
  }
});

const requireServer = () => {
  if (!serverUp) throw new Error('copyparty not reachable; skipping');
};

describe('testServerConnection', () => {
  it('resolves with correct credentials', async () => {
    requireServer();
    await expect(
      testServerConnection({ baseUrl: COPYPARTY_URL, password: COPYPARTY_PW }),
    ).resolves.toBeUndefined();
  });

  it('throws auth error on wrong password', async () => {
    requireServer();
    await expect(
      testServerConnection({ baseUrl: COPYPARTY_URL, password: 'definitely-wrong' }),
    ).rejects.toMatchObject({
      name: 'TestConnectionError',
      kind: 'auth',
    });
  });

  it('throws unreachable error when host is down', async () => {
    // Port 1 is reserved and reliably refuses connections.
    await expect(
      testServerConnection({ baseUrl: 'http://127.0.0.1:1', password: 'x' }),
    ).rejects.toMatchObject({
      name: 'TestConnectionError',
      kind: 'unreachable',
    });
  });
});

describe('Basic auth when a username is set', () => {
  // Regression for the 403 a username-bearing Server hit against a copyparty
  // that is NOT run with --usernames (the docker test server). The old
  // verbatim `PW: user:pass` header is rejected there; HTTP Basic auth
  // authenticates on both server types.
  it('authenticates as the account (not anonymous) via CopypartyClient', async () => {
    requireServer();
    const client = new CopypartyClient({
      baseUrl: COPYPARTY_URL,
      username: COPYPARTY_USER,
      password: COPYPARTY_PW,
    });
    const ls = await client.listFolder('/');
    // acct '*' would mean the credential was rejected (anonymous fallback).
    expect(ls.acct).toBe(COPYPARTY_USER);
    expect(ls.perms).toContain('write');
  });

  it('testServerConnection resolves with a username set', async () => {
    requireServer();
    await expect(
      testServerConnection({
        baseUrl: COPYPARTY_URL,
        username: COPYPARTY_USER,
        password: COPYPARTY_PW,
      }),
    ).resolves.toBeUndefined();
  });
});

describe('testJobConnection', () => {
  it('resolves with remoteOk:true on a writable path', async () => {
    requireServer();
    // The `test` user has `A` (all perms) on `/w` in tests/docker-compose.yml,
    // so the root "/" is writable. Uniqueness isn't required here — we're
    // only reading `?ls` and checking perms.
    const result = await testJobConnection({
      baseUrl: COPYPARTY_URL,
      password: COPYPARTY_PW,
      remotePath: '/',
    });
    expect(result.remoteOk).toBe(true);
    expect(result.localOk).toBe(true);
  });

  it('throws not_found on a missing remote path', async () => {
    requireServer();
    const missing = uniqueRemoteFolder('does-not-exist');
    await expect(
      testJobConnection({
        baseUrl: COPYPARTY_URL,
        password: COPYPARTY_PW,
        remotePath: missing,
      }),
    ).rejects.toMatchObject({
      name: 'TestConnectionError',
      kind: 'not_found',
    });
  });

  it('throws auth error on wrong password', async () => {
    requireServer();
    await expect(
      testJobConnection({
        baseUrl: COPYPARTY_URL,
        password: 'definitely-wrong',
        remotePath: '/',
      }),
    ).rejects.toMatchObject({
      name: 'TestConnectionError',
      kind: 'auth',
    });
  });

  it('exports TestConnectionError class', () => {
    // Sanity — consumers discriminate on `err.kind`, not instanceof.
    expect(new TestConnectionError('x', 'unknown').kind).toBe('unknown');
  });

  // TODO(test-buttons): add a read_only case once tests/docker-compose.yml
  // grows a second volume with read-only perms for the test user. Not added
  // now — out of scope per docs/test-buttons-plan.md.
});
