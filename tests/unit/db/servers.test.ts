import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createServer,
  deleteServer,
  getServer,
  listServers,
  updateServer,
} from '@/src/db/servers';
import { runMigrations } from '@/src/db/schema';

import { createTestDb } from './adapter';

let db: ReturnType<typeof createTestDb>;

beforeEach(async () => {
  db = createTestDb();
  await runMigrations(db);
});
afterEach(() => {
  db.close();
});

describe('servers DAO', () => {
  it('creates and retrieves a server', async () => {
    const id = await createServer(db, {
      name: 'home',
      base_url: 'https://copyparty.local:3923',
      username: 'jonny',
    });
    expect(id).toBeGreaterThan(0);
    const row = await getServer(db, id);
    expect(row?.name).toBe('home');
    expect(row?.base_url).toBe('https://copyparty.local:3923');
    expect(row?.username).toBe('jonny');
    expect(row?.cert_sha256).toBeNull();
    expect(row?.created_at).toBe(row?.updated_at);
  });

  it('lists servers most-recent first', async () => {
    const a = await createServer(db, { name: 'a', base_url: 'https://a' });
    await new Promise((r) => setTimeout(r, 2));
    const b = await createServer(db, { name: 'b', base_url: 'https://b' });
    const rows = await listServers(db);
    expect(rows.map((r) => r.id)).toEqual([b, a]);
  });

  it('updates a server and bumps updated_at', async () => {
    const id = await createServer(db, {
      name: 'orig',
      base_url: 'https://orig',
    });
    const before = await getServer(db, id);
    await new Promise((r) => setTimeout(r, 2));
    await updateServer(db, id, {
      name: 'renamed',
      base_url: 'https://new',
      cert_sha256: 'a'.repeat(64),
    });
    const after = await getServer(db, id);
    expect(after?.name).toBe('renamed');
    expect(after?.base_url).toBe('https://new');
    expect(after?.cert_sha256).toBe('a'.repeat(64));
    expect(after!.updated_at).toBeGreaterThan(before!.updated_at);
    expect(after!.created_at).toBe(before!.created_at);
  });

  it('deleting a server cascades to its jobs', async () => {
    const id = await createServer(db, { name: 's', base_url: 'https://s' });
    await db.runAsync(
      `INSERT INTO jobs (server_id, name, source_kind, source_uri, remote_path, created_at, updated_at)
       VALUES (?, 'j', 'saf', 'content://x', '/r', ?, ?)`,
      [id, Date.now(), Date.now()],
    );
    const before = await db.getFirstAsync<{ n: number }>(
      'SELECT COUNT(*) AS n FROM jobs WHERE server_id = ?',
      [id],
    );
    expect(before?.n).toBe(1);
    await deleteServer(db, id);
    const after = await db.getFirstAsync<{ n: number }>(
      'SELECT COUNT(*) AS n FROM jobs WHERE server_id = ?',
      [id],
    );
    expect(after?.n).toBe(0);
  });
});
