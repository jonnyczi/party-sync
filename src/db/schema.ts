import type { SqliteDb } from './adapter';

interface Migration {
  version: number;
  up: string;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up: `
      CREATE TABLE servers (
        id           INTEGER PRIMARY KEY,
        name         TEXT NOT NULL,
        base_url     TEXT NOT NULL,
        username     TEXT,
        cert_sha256  TEXT,
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL
      );

      CREATE TABLE jobs (
        id                    INTEGER PRIMARY KEY,
        server_id             INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
        name                  TEXT NOT NULL,
        source_kind           TEXT NOT NULL CHECK (source_kind IN ('saf','media')),
        source_uri            TEXT NOT NULL,
        remote_path           TEXT NOT NULL,
        propagate_deletes     INTEGER NOT NULL DEFAULT 0,
        wifi_only             INTEGER NOT NULL DEFAULT 1,
        respect_data_saver    INTEGER NOT NULL DEFAULT 1,
        charging_only         INTEGER NOT NULL DEFAULT 0,
        rehash_interval_days  INTEGER NOT NULL DEFAULT 30,
        created_at            INTEGER NOT NULL,
        updated_at            INTEGER NOT NULL
      );

      CREATE INDEX idx_jobs_server ON jobs(server_id);

      CREATE TABLE file_state (
        job_id          INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        local_path      TEXT NOT NULL,
        size            INTEGER NOT NULL,
        mtime_ms        INTEGER NOT NULL,
        wark            TEXT,
        last_hashed_at  INTEGER,
        uploaded_at     INTEGER,
        PRIMARY KEY (job_id, local_path)
      );

      CREATE INDEX idx_file_state_job ON file_state(job_id);

      CREATE TABLE runs (
        id              INTEGER PRIMARY KEY,
        job_id          INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        started_at      INTEGER NOT NULL,
        finished_at     INTEGER,
        trigger         TEXT NOT NULL,
        status          TEXT NOT NULL,
        files_scanned   INTEGER NOT NULL DEFAULT 0,
        files_uploaded  INTEGER NOT NULL DEFAULT 0,
        files_skipped   INTEGER NOT NULL DEFAULT 0,
        files_failed    INTEGER NOT NULL DEFAULT 0,
        bytes_uploaded  INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX idx_runs_job_started ON runs(job_id, started_at DESC);

      CREATE TABLE run_errors (
        id          INTEGER PRIMARY KEY,
        run_id      INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        local_path  TEXT NOT NULL,
        phase       TEXT NOT NULL,
        http_status INTEGER,
        message     TEXT
      );

      CREATE INDEX idx_run_errors_run ON run_errors(run_id);
    `,
  },
  {
    version: 2,
    up: `
      ALTER TABLE jobs ADD COLUMN periodic_enabled INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE jobs ADD COLUMN periodic_minutes INTEGER NOT NULL DEFAULT 60;
      ALTER TABLE runs ADD COLUMN skip_reason TEXT;
    `,
  },
  {
    version: 3,
    up: `
      ALTER TABLE jobs ADD COLUMN path_organization TEXT NOT NULL DEFAULT 'flat'
        CHECK (path_organization IN ('flat','year','year_month','year_month_day'));
    `,
  },
];

/**
 * Enable FK enforcement for this connection. SQLite's foreign-key checks are
 * per-connection, so callers must run this on every new handle before doing
 * anything else. Safe to call repeatedly.
 */
export async function configureConnection(db: SqliteDb): Promise<void> {
  await db.execAsync('PRAGMA foreign_keys = ON;');
}

/**
 * Apply any outstanding migrations in order. Idempotent: completed versions
 * are recorded in `schema_migrations` and skipped on subsequent runs.
 */
export async function runMigrations(db: SqliteDb): Promise<void> {
  await configureConnection(db);
  await db.execAsync(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);',
  );
  const applied = await db.getAllAsync<{ version: number }>(
    'SELECT version FROM schema_migrations',
    [],
  );
  const appliedSet = new Set(applied.map((r) => r.version));

  for (const m of MIGRATIONS) {
    if (appliedSet.has(m.version)) continue;
    await db.withTransactionAsync(async () => {
      await db.execAsync(m.up);
      await db.runAsync(
        'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
        [m.version, Date.now()],
      );
    });
  }
}

export const CURRENT_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;
