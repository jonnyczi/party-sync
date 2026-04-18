import type { SqliteDb } from './adapter';
import type { ServerRow } from './types';

export interface ServerInput {
  name: string;
  base_url: string;
  username?: string | null;
  cert_sha256?: string | null;
}

export async function listServers(db: SqliteDb): Promise<ServerRow[]> {
  return db.getAllAsync<ServerRow>(
    'SELECT * FROM servers ORDER BY updated_at DESC, id DESC',
    [],
  );
}

export async function getServer(
  db: SqliteDb,
  id: number,
): Promise<ServerRow | null> {
  return db.getFirstAsync<ServerRow>('SELECT * FROM servers WHERE id = ?', [id]);
}

export async function createServer(
  db: SqliteDb,
  input: ServerInput,
): Promise<number> {
  const now = Date.now();
  const res = await db.runAsync(
    `INSERT INTO servers (name, base_url, username, cert_sha256, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      input.name,
      input.base_url,
      input.username ?? null,
      input.cert_sha256 ?? null,
      now,
      now,
    ],
  );
  return res.lastInsertRowId;
}

export async function updateServer(
  db: SqliteDb,
  id: number,
  input: ServerInput,
): Promise<void> {
  await db.runAsync(
    `UPDATE servers
     SET name = ?, base_url = ?, username = ?, cert_sha256 = ?, updated_at = ?
     WHERE id = ?`,
    [
      input.name,
      input.base_url,
      input.username ?? null,
      input.cert_sha256 ?? null,
      Date.now(),
      id,
    ],
  );
}

/**
 * Delete a server and everything that depends on it (jobs → file_state, runs,
 * run_errors — all reach it via ON DELETE CASCADE). The matching secure-store
 * entry is the caller's responsibility.
 */
export async function deleteServer(db: SqliteDb, id: number): Promise<void> {
  await db.runAsync('DELETE FROM servers WHERE id = ?', [id]);
}
