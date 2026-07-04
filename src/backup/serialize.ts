import type { JobRow, ServerRow } from '@/src/db/types';

import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  isPathOrganization,
  isSourceKind,
  type BackupBundleV1,
  type BackupJob,
  type BackupServer,
} from './schema';

export interface BuildBundleInput {
  servers: ServerRow[];
  jobs: JobRow[];
  /** serverId -> password; consulted only when `includePasswords` is set. */
  passwords: Map<number, string | null>;
  includePasswords: boolean;
  appVersion: string;
  now?: number;
}

/**
 * Turn the device's servers + jobs into a portable bundle. Pure — no native
 * imports, no DB access — so it is fully unit-testable.
 */
export function buildBundle(input: BuildBundleInput): BackupBundleV1 {
  const refByServerId = new Map<number, string>();
  const servers: BackupServer[] = input.servers.map((s, i) => {
    const refId = `s${i}`;
    refByServerId.set(s.id, refId);
    const out: BackupServer = {
      refId,
      name: s.name,
      base_url: s.base_url,
      username: s.username,
      cert_sha256: s.cert_sha256,
    };
    if (input.includePasswords) {
      const pw = input.passwords.get(s.id);
      if (pw) out.password = pw;
    }
    return out;
  });

  const jobs: BackupJob[] = [];
  for (const j of input.jobs) {
    const serverRef = refByServerId.get(j.server_id);
    if (serverRef === undefined) continue; // orphan job; skip defensively
    const job: BackupJob = {
      serverRef,
      name: j.name,
      source_kind: j.source_kind,
      remote_path: j.remote_path,
      path_organization: j.path_organization,
      propagate_deletes: j.propagate_deletes === 1,
      wifi_only: j.wifi_only === 1,
      respect_data_saver: j.respect_data_saver === 1,
      charging_only: j.charging_only === 1,
      rehash_interval_days: j.rehash_interval_days,
      periodic_enabled: j.periodic_enabled === 1,
      periodic_minutes: j.periodic_minutes,
      max_concurrency: j.max_concurrency,
    };
    // Only `media` source URIs are portable (a sentinel); omit `saf` URIs.
    if (j.source_kind === 'media') job.source_uri = j.source_uri;
    jobs.push(job);
  }

  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    appVersion: input.appVersion,
    exportedAt: input.now ?? Date.now(),
    includesPasswords: input.includePasswords && servers.some((s) => s.password),
    servers,
    jobs,
  };
}

export function serializeBundle(bundle: BackupBundleV1): string {
  return JSON.stringify(bundle);
}

class BackupParseError extends Error {}

function fail(msg: string): never {
  throw new BackupParseError(msg);
}

function asString(v: unknown, field: string): string {
  if (typeof v !== 'string') fail(`Expected "${field}" to be a string`);
  return v as string;
}

function asNullableString(v: unknown, field: string): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') fail(`Expected "${field}" to be a string or null`);
  return v;
}

function asBool(v: unknown, field: string): boolean {
  if (typeof v !== 'boolean') fail(`Expected "${field}" to be a boolean`);
  return v;
}

function asNumber(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    fail(`Expected "${field}" to be a number`);
  }
  return v;
}

/**
 * Parse + validate a (decrypted) bundle string. Throws a human-readable Error
 * if the file is not a recognizable backup, the version is unsupported, or any
 * field is malformed.
 */
export function parseBundle(text: string): BackupBundleV1 {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    fail('This file is not valid JSON.');
  }
  if (typeof raw !== 'object' || raw === null) fail('Unexpected backup contents.');
  const obj = raw as Record<string, unknown>;

  if (obj.format !== BACKUP_FORMAT) {
    fail('This does not look like a copyparty-client backup.');
  }
  if (obj.version !== BACKUP_VERSION) {
    fail(
      `Unsupported backup version: ${String(obj.version)}. This app supports version ${BACKUP_VERSION}.`,
    );
  }
  if (!Array.isArray(obj.servers)) fail('Backup is missing its servers list.');
  if (!Array.isArray(obj.jobs)) fail('Backup is missing its jobs list.');

  const refIds = new Set<string>();
  const servers: BackupServer[] = obj.servers.map((s, i) => {
    if (typeof s !== 'object' || s === null) fail(`Server #${i + 1} is malformed.`);
    const so = s as Record<string, unknown>;
    const refId = asString(so.refId, `servers[${i}].refId`);
    if (refIds.has(refId)) fail(`Duplicate server ref "${refId}".`);
    refIds.add(refId);
    const server: BackupServer = {
      refId,
      name: asString(so.name, `servers[${i}].name`),
      base_url: asString(so.base_url, `servers[${i}].base_url`),
      username: asNullableString(so.username, `servers[${i}].username`),
      cert_sha256: asNullableString(so.cert_sha256, `servers[${i}].cert_sha256`),
    };
    if (so.password !== undefined) {
      server.password = asString(so.password, `servers[${i}].password`);
    }
    return server;
  });

  const jobs: BackupJob[] = obj.jobs.map((j, i) => {
    if (typeof j !== 'object' || j === null) fail(`Job #${i + 1} is malformed.`);
    const jo = j as Record<string, unknown>;
    const serverRef = asString(jo.serverRef, `jobs[${i}].serverRef`);
    if (!refIds.has(serverRef)) {
      fail(`Job "${String(jo.name)}" references an unknown server.`);
    }
    if (!isSourceKind(jo.source_kind)) fail(`jobs[${i}].source_kind is invalid.`);
    if (!isPathOrganization(jo.path_organization)) {
      fail(`jobs[${i}].path_organization is invalid.`);
    }
    const job: BackupJob = {
      serverRef,
      name: asString(jo.name, `jobs[${i}].name`),
      source_kind: jo.source_kind,
      remote_path: asString(jo.remote_path, `jobs[${i}].remote_path`),
      path_organization: jo.path_organization,
      propagate_deletes: asBool(jo.propagate_deletes, `jobs[${i}].propagate_deletes`),
      wifi_only: asBool(jo.wifi_only, `jobs[${i}].wifi_only`),
      respect_data_saver: asBool(jo.respect_data_saver, `jobs[${i}].respect_data_saver`),
      charging_only: asBool(jo.charging_only, `jobs[${i}].charging_only`),
      rehash_interval_days: asNumber(jo.rehash_interval_days, `jobs[${i}].rehash_interval_days`),
      periodic_enabled: asBool(jo.periodic_enabled, `jobs[${i}].periodic_enabled`),
      periodic_minutes: asNumber(jo.periodic_minutes, `jobs[${i}].periodic_minutes`),
      // Pre-v4 backups predate per-job concurrency; createJob fills the default.
      max_concurrency:
        jo.max_concurrency === undefined
          ? undefined
          : asNumber(jo.max_concurrency, `jobs[${i}].max_concurrency`),
    };
    if (jo.source_uri !== undefined) {
      job.source_uri = asString(jo.source_uri, `jobs[${i}].source_uri`);
    }
    return job;
  });

  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    appVersion: typeof obj.appVersion === 'string' ? obj.appVersion : 'unknown',
    exportedAt: typeof obj.exportedAt === 'number' ? obj.exportedAt : 0,
    includesPasswords: obj.includesPasswords === true,
    servers,
    jobs,
  };
}
