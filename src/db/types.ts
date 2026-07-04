export interface ServerRow {
  id: number;
  name: string;
  base_url: string;
  username: string | null;
  cert_sha256: string | null;
  created_at: number;
  updated_at: number;
}

export type SourceKind = 'saf' | 'media';

/**
 * How a job buckets uploads into date subfolders under `remote_path`, based on
 * each file's modification time. `flat` preserves the local subfolder structure
 * (legacy behavior); the date modes flatten it into Y / Y-M / Y-M-D folders.
 */
export type PathOrganization = 'flat' | 'year' | 'year_month' | 'year_month_day';

export interface JobRow {
  id: number;
  server_id: number;
  name: string;
  source_kind: SourceKind;
  source_uri: string;
  remote_path: string;
  path_organization: PathOrganization;
  propagate_deletes: number;
  wifi_only: number;
  respect_data_saver: number;
  charging_only: number;
  rehash_interval_days: number;
  periodic_enabled: number;
  periodic_minutes: number;
  /** Max files uploaded in parallel for this job (clamped 1–8; default 3). */
  max_concurrency: number;
  /** Post a result notification when a run for this job succeeds (1) or not (0). */
  notify_on_success: number;
  /** Post a result notification when a run for this job fails/partials (1) or not (0). */
  notify_on_failure: number;
  created_at: number;
  updated_at: number;
}

export interface FileStateRow {
  job_id: number;
  local_path: string;
  size: number;
  mtime_ms: number;
  wark: string | null;
  last_hashed_at: number | null;
  uploaded_at: number | null;
}

export type RunTrigger = 'manual' | 'periodic' | 'observer' | 'retry';
export type RunStatus =
  | 'running'
  | 'ok'
  | 'partial'
  | 'failed'
  | 'skipped'
  | 'cancelled';
export type SkipReason =
  | 'wifi_only'
  | 'data_saver'
  | 'charging_only'
  | 'already_running';
export type ErrorPhase = 'stat' | 'hash' | 'handshake' | 'upload' | 'finalize';

export interface RunRow {
  id: number;
  job_id: number;
  started_at: number;
  finished_at: number | null;
  trigger: RunTrigger;
  status: RunStatus;
  files_scanned: number;
  files_uploaded: number;
  files_skipped: number;
  files_failed: number;
  bytes_uploaded: number;
  /** Bytes the server already had (dedup) and we therefore skipped sending. */
  bytes_deduped: number;
  skip_reason: string | null;
}

export interface RunErrorRow {
  id: number;
  run_id: number;
  local_path: string;
  phase: ErrorPhase;
  http_status: number | null;
  message: string | null;
}
