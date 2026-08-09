import type { BandwidthMode } from '@/src/db/settings';
import type { PathOrganization, SourceKind } from '@/src/db/types';

// Versioned, portable representation of the app's configuration. Only the
// fields that make sense on another device are carried; device-local data
// (auto-increment ids, SAF source URIs, file_state, run history) is excluded.
// See docs/roadmap.md / the backup feature plan for the portability rationale.

export const BACKUP_FORMAT = 'copyparty-client-backup' as const;
export const BACKUP_VERSION = 1 as const;

export interface BackupServer {
  /** In-bundle ref used to link jobs to servers; NOT a device id. */
  refId: string;
  name: string;
  base_url: string;
  username: string | null;
  cert_sha256: string | null;
  /** Present only when the export was created with "include passwords". */
  password?: string;
}

export interface BackupJob {
  /** Matches a BackupServer.refId in the same bundle. */
  serverRef: string;
  name: string;
  source_kind: SourceKind;
  /**
   * Only carried for `media` jobs (a portable sentinel like `all`). `saf`
   * source URIs are a per-device Android permission grant, so they are
   * omitted and the folder must be re-selected after import.
   */
  source_uri?: string;
  remote_path: string;
  path_organization: PathOrganization;
  propagate_deletes: boolean;
  wifi_only: boolean;
  respect_data_saver: boolean;
  charging_only: boolean;
  rehash_interval_days: number;
  periodic_enabled: boolean;
  periodic_minutes: number;
  /** Optional for backward compat with pre-v4 backups; defaults on import. */
  max_concurrency?: number;
  /** Per-job result-notification toggles; optional for older backups (default on). */
  notify_on_success?: boolean;
  notify_on_failure?: boolean;
}

export interface BackupBundleV1 {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_VERSION;
  /** App version that produced the export (informational). */
  appVersion: string;
  exportedAt: number;
  /** Whether server passwords are included (only ever true inside an
   *  encrypted envelope). */
  includesPasswords: boolean;
  servers: BackupServer[];
  jobs: BackupJob[];
  /**
   * App-wide preferences. Optional for backward compat with older backups, and
   * each field is independently optional so a bundle written by a version that
   * predates one of them still applies the rest.
   */
  settings?: { resultNotifications?: boolean; bandwidthMode?: BandwidthMode };
}

const SOURCE_KINDS: readonly SourceKind[] = ['saf', 'media'];
const PATH_ORGS: readonly PathOrganization[] = [
  'flat',
  'year',
  'year_month',
  'year_month_day',
];

export function isSourceKind(v: unknown): v is SourceKind {
  return typeof v === 'string' && SOURCE_KINDS.includes(v as SourceKind);
}

export function isPathOrganization(v: unknown): v is PathOrganization {
  return typeof v === 'string' && PATH_ORGS.includes(v as PathOrganization);
}
