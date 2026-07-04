import type { SqliteDb } from '@/src/db/adapter';
import { createJob, listJobs } from '@/src/db/jobs';
import { createServer, listServers } from '@/src/db/servers';
import { setResultNotificationsEnabled } from '@/src/db/settings';
import { MEDIA_SOURCE_ALL } from '@/src/sync/walker/media';

import type { BackupBundleV1 } from './schema';

export interface ImportSummary {
  serversAdded: number;
  serversSkipped: number;
  jobsAdded: number;
  jobsSkipped: number;
  /** saf jobs that imported without a source folder (must be re-picked). */
  jobsNeedingSource: number;
}

export interface ImportDeps {
  /**
   * Persist a server password. Injected (rather than importing
   * `@/src/storage/secrets` directly) so this module carries no native
   * dependency and stays unit-testable under vitest.
   */
  setPassword: (serverId: number, password: string) => Promise<void>;
}

function serverKey(baseUrl: string, username: string | null): string {
  // NUL separator can't appear in a URL or username, so this is unambiguous.
  return `${baseUrl}\x00${username ?? ''}`;
}

function jobKey(serverId: number, name: string): string {
  return `${serverId}\x00${name}`;
}

/**
 * Merge a parsed bundle into the database, skipping duplicates
 * (non-destructive). Servers match on (base_url, username); jobs match on
 * (server_id, name). Reuses the existing DAOs so all DB invariants hold.
 *
 * `saf` jobs are created with an empty `source_uri` — the local folder grant
 * is device-specific and must be re-selected on the edit screen before the job
 * can run. `media` jobs carry their portable sentinel and import ready to use.
 */
export async function importBundle(
  db: SqliteDb,
  bundle: BackupBundleV1,
  deps: ImportDeps,
): Promise<ImportSummary> {
  const summary: ImportSummary = {
    serversAdded: 0,
    serversSkipped: 0,
    jobsAdded: 0,
    jobsSkipped: 0,
    jobsNeedingSource: 0,
  };

  const existingServers = await listServers(db);
  const serverIdByKey = new Map<string, number>(
    existingServers.map((s) => [serverKey(s.base_url, s.username), s.id]),
  );
  const refToServerId = new Map<string, number>();

  for (const s of bundle.servers) {
    const key = serverKey(s.base_url, s.username);
    const existing = serverIdByKey.get(key);
    if (existing !== undefined) {
      refToServerId.set(s.refId, existing);
      summary.serversSkipped++;
      continue;
    }
    const id = await createServer(db, {
      name: s.name,
      base_url: s.base_url,
      username: s.username,
      cert_sha256: s.cert_sha256,
    });
    if (s.password) await deps.setPassword(id, s.password);
    refToServerId.set(s.refId, id);
    serverIdByKey.set(key, id); // dedup against later bundle entries too
    summary.serversAdded++;
  }

  const existingJobs = await listJobs(db);
  const jobKeys = new Set<string>(
    existingJobs.map((j) => jobKey(j.server_id, j.name)),
  );

  for (const j of bundle.jobs) {
    const serverId = refToServerId.get(j.serverRef);
    if (serverId === undefined) {
      summary.jobsSkipped++;
      continue;
    }
    const key = jobKey(serverId, j.name);
    if (jobKeys.has(key)) {
      summary.jobsSkipped++;
      continue;
    }
    const source_uri =
      j.source_kind === 'media' ? j.source_uri || MEDIA_SOURCE_ALL : '';
    if (j.source_kind === 'saf') summary.jobsNeedingSource++;
    await createJob(db, {
      server_id: serverId,
      name: j.name,
      source_kind: j.source_kind,
      source_uri,
      remote_path: j.remote_path,
      path_organization: j.path_organization,
      propagate_deletes: j.propagate_deletes,
      wifi_only: j.wifi_only,
      respect_data_saver: j.respect_data_saver,
      charging_only: j.charging_only,
      rehash_interval_days: j.rehash_interval_days,
      periodic_enabled: j.periodic_enabled,
      periodic_minutes: j.periodic_minutes,
      max_concurrency: j.max_concurrency,
      notify_on_success: j.notify_on_success,
      notify_on_failure: j.notify_on_failure,
    });
    jobKeys.add(key);
    summary.jobsAdded++;
  }

  // Apply the global notification preference if the bundle carried one. Direct
  // call (not via deps) is fine: src/db/settings has no native dependency.
  if (bundle.settings) {
    await setResultNotificationsEnabled(db, bundle.settings.resultNotifications);
  }

  return summary;
}
