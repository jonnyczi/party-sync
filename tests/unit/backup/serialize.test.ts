import { describe, expect, it } from 'vitest';

import { BACKUP_FORMAT } from '@/src/backup/schema';
import {
  buildBundle,
  parseBundle,
  serializeBundle,
  type BuildBundleInput,
} from '@/src/backup/serialize';
import type { JobRow, ServerRow } from '@/src/db/types';

function server(over: Partial<ServerRow> = {}): ServerRow {
  return {
    id: 1,
    name: 'home',
    base_url: 'https://copyparty.local:3923',
    username: 'jonny',
    cert_sha256: null,
    created_at: 1,
    updated_at: 1,
    ...over,
  };
}

function job(over: Partial<JobRow> = {}): JobRow {
  return {
    id: 1,
    server_id: 1,
    name: 'camera',
    source_kind: 'saf',
    source_uri: 'content://device-specific/tree',
    remote_path: '/phone/camera',
    path_organization: 'year_month',
    propagate_deletes: 0,
    wifi_only: 1,
    respect_data_saver: 1,
    charging_only: 0,
    rehash_interval_days: 30,
    periodic_enabled: 1,
    periodic_minutes: 90,
    max_concurrency: 3,
    created_at: 1,
    updated_at: 1,
    ...over,
  };
}

function input(over: Partial<BuildBundleInput> = {}): BuildBundleInput {
  return {
    servers: [server()],
    jobs: [job()],
    passwords: new Map([[1, 'hunter2']]),
    includePasswords: false,
    appVersion: '1.0.0',
    now: 12345,
    ...over,
  };
}

describe('buildBundle', () => {
  it('produces a versioned bundle and links jobs by ref, not db id', () => {
    const b = buildBundle(input());
    expect(b.format).toBe(BACKUP_FORMAT);
    expect(b.version).toBe(1);
    expect(b.exportedAt).toBe(12345);
    expect(b.servers).toHaveLength(1);
    expect(b.jobs[0].serverRef).toBe(b.servers[0].refId);
    // converts sqlite 0/1 ints to booleans
    expect(b.jobs[0].wifi_only).toBe(true);
    expect(b.jobs[0].propagate_deletes).toBe(false);
    expect(b.jobs[0].periodic_enabled).toBe(true);
  });

  it('omits passwords unless includePasswords is set', () => {
    expect(buildBundle(input()).servers[0].password).toBeUndefined();
    const withPw = buildBundle(input({ includePasswords: true }));
    expect(withPw.servers[0].password).toBe('hunter2');
    expect(withPw.includesPasswords).toBe(true);
  });

  it('omits the saf source URI but keeps the portable media sentinel', () => {
    const b = buildBundle(
      input({
        jobs: [
          job({ id: 1, source_kind: 'saf', source_uri: 'content://x' }),
          job({ id: 2, source_kind: 'media', source_uri: 'all' }),
        ],
      }),
    );
    expect(b.jobs[0].source_uri).toBeUndefined();
    expect(b.jobs[1].source_uri).toBe('all');
  });

  it('drops jobs whose server is not in the export', () => {
    const b = buildBundle(input({ jobs: [job({ server_id: 999 })] }));
    expect(b.jobs).toHaveLength(0);
  });
});

describe('parseBundle', () => {
  it('round-trips a serialized bundle', () => {
    const original = buildBundle(input({ includePasswords: true }));
    const parsed = parseBundle(serializeBundle(original));
    expect(parsed).toEqual(original);
  });

  it('rejects non-JSON', () => {
    expect(() => parseBundle('not json')).toThrow(/not valid JSON/i);
  });

  it('rejects an unrecognized file', () => {
    expect(() => parseBundle(JSON.stringify({ hello: 'world' }))).toThrow(
      /copyparty-client backup/i,
    );
  });

  it('rejects an unsupported version', () => {
    const bundle = { ...buildBundle(input()), version: 2 };
    expect(() => parseBundle(JSON.stringify(bundle))).toThrow(/version/i);
  });

  it('rejects a job referencing an unknown server', () => {
    const bundle = buildBundle(input());
    bundle.jobs[0].serverRef = 'nope';
    expect(() => parseBundle(JSON.stringify(bundle))).toThrow(/unknown server/i);
  });

  it('rejects a malformed field', () => {
    const bundle: any = buildBundle(input());
    bundle.jobs[0].wifi_only = 'yes';
    expect(() => parseBundle(JSON.stringify(bundle))).toThrow(/wifi_only/i);
  });
});
