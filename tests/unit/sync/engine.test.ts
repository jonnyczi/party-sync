import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CopypartyClient } from '@/src/copyparty/client';
import type { FileSource } from '@/src/copyparty/hash';
import { createJob } from '@/src/db/jobs';
import { listRunErrors } from '@/src/db/runs';
import { runMigrations } from '@/src/db/schema';
import { createServer } from '@/src/db/servers';
import { runJob } from '@/src/sync/engine';
import { dateSubdir } from '@/src/sync/path-organization';
import { ProgressBus } from '@/src/sync/progress';
import { isCancelRequested, requestCancel } from '@/src/sync/run-control';
import type { SourceWalker, WalkerEntry } from '@/src/sync/walker/types';

import { createTestDb } from '../db/adapter';

const MIB = 1024 * 1024;

let db: ReturnType<typeof createTestDb>;
let jobId: number;

beforeEach(async () => {
  db = createTestDb();
  await runMigrations(db);
  const serverId = await createServer(db, { name: 's', base_url: 'http://localhost:9999' });
  jobId = await createJob(db, {
    server_id: serverId,
    name: 'j',
    source_kind: 'saf',
    source_uri: 'content://fake/tree',
    remote_path: '/target',
  });
});
afterEach(() => db.close());

describe('engine.runJob', () => {
  it('uploads a new file and records file_state + run counters', async () => {
    // 2.5 MiB → 1 MiB chunksize → 3 chunks, stitched into a single POST.
    const entry = makeEntry('a.bin', 2.5 * MIB);
    const server = makeFakeServer([entry]);

    const progress = new ProgressBus();
    const run = await runJob(
      {
        db,
        walker: fakeWalker([entry]),
        client: server.client,
        fileSource: makeFileSource([entry]),
        progress,
        sleep: noSleep,
      },
      jobId,
    );

    expect(run.status).toBe('ok');
    expect(run.files_scanned).toBe(1);
    expect(run.files_uploaded).toBe(1);
    expect(run.files_failed).toBe(0);
    expect(run.bytes_uploaded).toBe(entry.size);
    expect(run.bytes_deduped).toBe(0);
    expect(server.chunkPosts).toBe(1); // 3 contiguous chunks → one stitched POST
    expect(server.handshakes).toBe(2); // initial + re-handshake

    const fs = await db.getFirstAsync<{ wark: string; uploaded_at: number }>(
      'SELECT wark, uploaded_at FROM file_state WHERE job_id = ? AND local_path = ?',
      [jobId, entry.localPath],
    );
    expect(fs?.wark).toBeTruthy();
    expect(fs?.uploaded_at).toBeGreaterThan(0);
    expect(progress.getSnapshot().activeRun).toBeNull();
  });

  it('skips a file whose (size, mtime) match prior uploaded file_state', async () => {
    const entry = makeEntry('b.bin', 500);
    await db.runAsync(
      `INSERT INTO file_state (job_id, local_path, size, mtime_ms, wark, last_hashed_at, uploaded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [jobId, entry.localPath, entry.size, entry.mtimeMs, 'prior-wark', 1000, 2000],
    );

    const server = makeFakeServer([entry]);
    const run = await runJob(
      {
        db,
        walker: fakeWalker([entry]),
        client: server.client,
        fileSource: makeFileSource([entry]),
        sleep: noSleep,
      },
      jobId,
    );

    expect(run.status).toBe('ok');
    expect(run.files_skipped).toBe(1);
    expect(run.files_uploaded).toBe(0);
    expect(server.handshakes).toBe(0);
    expect(server.chunkPosts).toBe(0);
  });

  it('re-uploads when file_state exists but size changed', async () => {
    const entry = makeEntry('c.bin', MIB + 1);
    await db.runAsync(
      `INSERT INTO file_state (job_id, local_path, size, mtime_ms, wark, last_hashed_at, uploaded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [jobId, entry.localPath, 100 /* stale size */, entry.mtimeMs, 'stale', 1, 2],
    );

    const server = makeFakeServer([entry]);
    const run = await runJob(
      {
        db,
        walker: fakeWalker([entry]),
        client: server.client,
        fileSource: makeFileSource([entry]),
        sleep: noSleep,
      },
      jobId,
    );

    expect(run.files_uploaded).toBe(1);
    expect(run.files_skipped).toBe(0);
  });

  it('records per-file error and continues on non-fatal server failure', async () => {
    const good = makeEntry('good.bin', 1000);
    const bad = makeEntry('bad.bin', 1000);
    const server = makeFakeServer([good, bad], {
      failHandshakeFor: { name: 'bad.bin', status: 500 },
    });

    const run = await runJob(
      {
        db,
        walker: fakeWalker([bad, good]),
        client: server.client,
        fileSource: makeFileSource([good, bad]),
        sleep: noSleep,
      },
      jobId,
    );

    expect(run.status).toBe('partial');
    expect(run.files_failed).toBe(1);
    expect(run.files_uploaded).toBe(1);
    expect(run.files_scanned).toBe(2);

    const errs = await listRunErrors(db, run.id);
    expect(errs).toHaveLength(1);
    expect(errs[0].local_path).toBe(bad.localPath);
    expect(errs[0].phase).toBe('handshake');
    expect(errs[0].http_status).toBe(500);
  });

  it('fails the entire run on 401 and stops scheduling subsequent files', async () => {
    // Pin concurrency to 1 so "the second file is never touched" is
    // deterministic — with a wider pool both files would be in flight at once.
    await db.runAsync('UPDATE jobs SET max_concurrency = 1 WHERE id = ?', [jobId]);
    const first = makeEntry('first.bin', 1000);
    const second = makeEntry('second.bin', 1000);
    const server = makeFakeServer([first, second], {
      failHandshakeFor: { name: 'first.bin', status: 401 },
    });

    const run = await runJob(
      {
        db,
        walker: fakeWalker([first, second]),
        client: server.client,
        fileSource: makeFileSource([first, second]),
        sleep: noSleep,
      },
      jobId,
    );

    expect(run.status).toBe('failed');
    // Both files are discovered in the pre-scan, but only the first is attempted.
    expect(run.files_scanned).toBe(2);
    expect(run.files_uploaded).toBe(0);
    expect(run.files_failed).toBe(0);

    const errs = await listRunErrors(db, run.id);
    expect(errs).toHaveLength(1);
    expect(errs[0].http_status).toBe(401);
    // 401 is not retryable and halts the pool — exactly one handshake.
    expect(server.handshakes).toBe(1);
  });

  it('wholesale-fails when the walker itself throws', async () => {
    const walker: SourceWalker = {
      async *walk() {
        throw new Error('permission revoked');
      },
    };

    const server = makeFakeServer([]);
    const run = await runJob(
      {
        db,
        walker,
        client: server.client,
        fileSource: makeFileSource([]),
        sleep: noSleep,
      },
      jobId,
    );

    expect(run.status).toBe('failed');
    const errs = await listRunErrors(db, run.id);
    expect(errs).toHaveLength(1);
    expect(errs[0].phase).toBe('stat');
    expect(errs[0].message).toContain('permission revoked');
  });

  it('retries transient 5xx on uploadChunk before giving up', async () => {
    // 1 KiB file is sub-chunk → exactly 1 chunk POST on a clean run. With
    // 2 injected 502s the retry wrapper should try 3 times (attempts 1+2
    // fail, attempt 3 succeeds).
    const entry = makeEntry('flaky.bin', 1024);
    const server = makeFakeServer([entry], {
      failChunkFor: { name: 'flaky.bin', status: 502, times: 2 },
    });

    const run = await runJob(
      {
        db,
        walker: fakeWalker([entry]),
        client: server.client,
        fileSource: makeFileSource([entry]),
        sleep: noSleep,
      },
      jobId,
    );

    expect(run.status).toBe('ok');
    expect(run.files_uploaded).toBe(1);
    expect(server.chunkPosts).toBe(3);
    expect(server.handshakes).toBe(2);
  });

  it('flattens into a date folder when path_organization is set', async () => {
    const mtimeMs = new Date(2026, 5, 20, 12, 0).getTime(); // 2026-06-20 local
    const entry: WalkerEntry = {
      localPath: 'Trips/Italy/photo.jpg',
      uri: 'content://fake/photo.jpg',
      relativePath: 'Trips/Italy/photo.jpg',
      size: 1000,
      mtimeMs,
    };
    const dateJobId = await createJob(db, {
      server_id: (await db.getFirstAsync<{ server_id: number }>(
        'SELECT server_id FROM jobs WHERE id = ?',
        [jobId],
      ))!.server_id,
      name: 'dated',
      source_kind: 'saf',
      source_uri: 'content://fake/tree',
      remote_path: '/target',
      path_organization: 'year_month_day',
    });

    const server = makeFakeServer([entry]);
    const run = await runJob(
      {
        db,
        walker: fakeWalker([entry]),
        client: server.client,
        fileSource: makeFileSource([entry]),
        sleep: noSleep,
      },
      dateJobId,
    );

    expect(run.files_uploaded).toBe(1);
    const expectedSub = dateSubdir(mtimeMs, 'year_month_day'); // 2026/06/20
    expect(server.handshakeUrls[0]).toBe(
      `http://localhost:9999/target/${expectedSub}/`,
    );
    // Local subfolders are dropped in date mode.
    expect(server.handshakeUrls[0]).not.toContain('Trips');
  });

  it('emits exact totalFiles and totalBytes from the pre-scan pass', async () => {
    const entries = [
      makeEntry('a.bin', 100),
      makeEntry('b.bin', 250),
      makeEntry('c.bin', 50),
    ];
    const server = makeFakeServer(entries);
    const progress = new ProgressBus();
    let seen: { totalFiles: number; totalBytes: number } | null = null;
    progress.subscribe(() => {
      const r = progress.getSnapshot().activeRun;
      if (r && r.totalFiles > 0) {
        seen = { totalFiles: r.totalFiles, totalBytes: r.totalBytes };
      }
    });

    await runJob(
      {
        db,
        walker: fakeWalker(entries),
        client: server.client,
        fileSource: makeFileSource(entries),
        progress,
        sleep: noSleep,
      },
      jobId,
    );

    expect(seen).toEqual({ totalFiles: 3, totalBytes: 400 });
  });

  it('uploads files in parallel but never exceeds max_concurrency in flight', async () => {
    await db.runAsync('UPDATE jobs SET max_concurrency = 2 WHERE id = ?', [jobId]);
    const entries = Array.from({ length: 6 }, (_, i) => makeEntry(`f${i}.bin`, 1000));
    const server = makeFakeServer(entries);

    let active = 0;
    let maxActive = 0;
    const base = makeFileSource(entries);
    const fileSource: FileSource = {
      hashFileChunks: base.hashFileChunks,
      size: base.size,
      async readRange(uri, car, cdr) {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return base.readRange(uri, car, cdr);
      },
    };

    const run = await runJob(
      { db, walker: fakeWalker(entries), client: server.client, fileSource, sleep: noSleep },
      jobId,
    );

    expect(run.files_uploaded).toBe(6);
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(maxActive).toBe(2); // parallelism actually reached the cap
  });

  it('accumulates bytes_deduped for files the server already has', async () => {
    const fresh = makeEntry('fresh.bin', 1500);
    const dup = makeEntry('dup.bin', 2000);
    const server = makeFakeServer([fresh, dup], { preexisting: ['dup.bin'] });

    const run = await runJob(
      {
        db,
        walker: fakeWalker([fresh, dup]),
        client: server.client,
        fileSource: makeFileSource([fresh, dup]),
        sleep: noSleep,
      },
      jobId,
    );

    expect(run.status).toBe('ok');
    expect(run.files_uploaded).toBe(2); // both "succeed"; one needed no bytes
    expect(run.bytes_uploaded).toBe(fresh.size); // only the fresh file's bytes
    expect(run.bytes_deduped).toBe(dup.size); // the pre-existing file was free
  });

  it('honors filterPaths: only listed paths are scanned and attempted', async () => {
    const a = makeEntry('a.bin', 1000);
    const b = makeEntry('b.bin', 1000);
    const c = makeEntry('c.bin', 1000);
    const server = makeFakeServer([a, b, c]);

    const run = await runJob(
      {
        db,
        walker: fakeWalker([a, b, c]),
        client: server.client,
        fileSource: makeFileSource([a, b, c]),
        filterPaths: new Set([b.localPath]),
        sleep: noSleep,
      },
      jobId,
    );

    expect(run.status).toBe('ok');
    // Only the listed path survives the scan; the others aren't even counted.
    expect(run.files_scanned).toBe(1);
    expect(run.files_uploaded).toBe(1);
    // One file → initial + re-handshake; if a/c had been attempted it'd be 6.
    expect(server.handshakes).toBe(2);

    const persisted = await db.getAllAsync<{ local_path: string }>(
      'SELECT local_path FROM file_state WHERE job_id = ? ORDER BY local_path',
      [jobId],
    );
    expect(persisted.map((r) => r.local_path)).toEqual([b.localPath]);
  });

  it('cancels mid-run: stops scheduling, finalizes as cancelled, clears registry', async () => {
    // Pin concurrency to 1 so "later files are never touched" is deterministic.
    await db.runAsync('UPDATE jobs SET max_concurrency = 1 WHERE id = ?', [jobId]);
    const entries = [
      makeEntry('a.bin', 1000),
      makeEntry('b.bin', 1000),
      makeEntry('c.bin', 1000),
    ];
    const server = makeFakeServer(entries);
    const progress = new ProgressBus();

    const base = makeFileSource(entries);
    const hashedUris = new Set<string>();
    const fileSource: FileSource = {
      size: base.size,
      async hashFileChunks(uri, chunksize) {
        hashedUris.add(uri);
        return base.hashFileChunks(uri, chunksize);
      },
      async readRange(uri, car, cdr) {
        // While the first file is uploading, request cancel of this run. The
        // worker pool checks between files, so the first file still completes
        // and the rest are never pulled. runId is published by startRun.
        if (uri === entries[0].uri) {
          const runId = progress.getSnapshot().activeRun?.runId;
          if (runId != null) requestCancel(runId);
        }
        return base.readRange(uri, car, cdr);
      },
    };

    const run = await runJob(
      {
        db,
        walker: fakeWalker(entries),
        client: server.client,
        fileSource,
        progress,
        sleep: noSleep,
      },
      jobId,
    );

    expect(run.status).toBe('cancelled');
    // All three were discovered in the scan, but only the first was uploaded.
    expect(run.files_scanned).toBe(3);
    expect(run.files_uploaded).toBe(1);
    expect(run.files_failed).toBe(0);
    // The later files were never even hashed.
    expect(hashedUris.has(entries[1].uri)).toBe(false);
    expect(hashedUris.has(entries[2].uri)).toBe(false);
    // The engine's `finally` clears the cancel registry entry.
    expect(isCancelRequested(run.id)).toBe(false);
  });

  it('tears down an in-flight upload on cancel without counting it as failed', async () => {
    await db.runAsync('UPDATE jobs SET max_concurrency = 1 WHERE id = ?', [jobId]);
    const entries = [makeEntry('a.bin', 1000), makeEntry('b.bin', 1000)];
    const progress = new ProgressBus();

    // Abort-honoring fetch (a real fetch rejects when its signal aborts; the
    // shared makeFakeServer mock does not, so we roll a minimal one here).
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit): Promise<Response> => {
      if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      const headers = normalizeHeaders(init?.headers);
      if (!headers['x-up2k-hash']) {
        const body = JSON.parse(init?.body as string) as { name: string; hash: string[] };
        return jsonResponse({ name: body.name, purl: '', wark: `w-${body.name}`, hash: body.hash, sprs: true });
      }
      return new Response('', { status: 200 });
    });
    const client = new CopypartyClient({
      baseUrl: 'http://localhost:9999',
      fetch: fetchMock as unknown as typeof fetch,
    });

    const base = makeFileSource(entries);
    const fileSource: FileSource = {
      size: base.size,
      hashFileChunks: base.hashFileChunks,
      async readRange(uri, car, cdr) {
        // Cancel while the first file's chunk is being read → its subsequent
        // upload POST hits an already-aborted signal and is torn down.
        if (uri === entries[0].uri) {
          const runId = progress.getSnapshot().activeRun?.runId;
          if (runId != null) requestCancel(runId);
        }
        return base.readRange(uri, car, cdr);
      },
    };

    const run = await runJob(
      { db, walker: fakeWalker(entries), client, fileSource, progress, sleep: noSleep },
      jobId,
    );

    expect(run.status).toBe('cancelled');
    // The aborted in-flight file completed neither as uploaded nor as failed…
    expect(run.files_uploaded).toBe(0);
    expect(run.files_failed).toBe(0);
    // …and it was not recorded as a per-file error.
    expect(await listRunErrors(db, run.id)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// fakes

function makeEntry(name: string, size: number): WalkerEntry {
  return {
    localPath: name,
    uri: `content://fake/${name}`,
    relativePath: name,
    size,
    mtimeMs: 1_700_000_000_000,
  };
}

function fakeWalker(entries: WalkerEntry[]): SourceWalker {
  return {
    async *walk() {
      for (const e of entries) yield e;
    },
  };
}

/**
 * FileSource that fakes SHA-512 output deterministically from (uri, index).
 * Tied to the fake server below — both derive chunk hashes the same way so
 * the server's `hash:[...]` response uses hashes the client's request body
 * actually contains.
 */
function makeFileSource(entries: WalkerEntry[]): FileSource {
  const sizesByUri = new Map(entries.map((e) => [e.uri, e.size]));
  return {
    async hashFileChunks(uri, chunksize) {
      const size = sizesByUri.get(uri);
      if (size === undefined) throw new Error(`no fake size for ${uri}`);
      const n = Math.ceil(size / chunksize);
      return Array.from({ length: n }, (_, i) => fakeChunkHash(uri, i));
    },
    async readRange(_uri, car, cdr) {
      return new Uint8Array(cdr - car);
    },
    async size(uri) {
      const s = sizesByUri.get(uri);
      if (s === undefined) throw new Error(`no fake size for ${uri}`);
      return s;
    },
  };
}

function fakeChunkHash(uri: string, index: number): string {
  // Deterministic 44-char base64url-shaped string. The server echoes these
  // back unchanged, so exact format doesn't matter as long as length is 44.
  const base = `${uri}|${index}`;
  return (base + 'A'.repeat(44)).slice(0, 44).replace(/[^A-Za-z0-9_-]/g, 'A');
}

interface FakeServerOptions {
  failHandshakeFor?: { name: string; status: number };
  failChunkFor?: { name: string; status: number; times: number };
  /** Names the server already holds in full (handshake returns no missing). */
  preexisting?: string[];
}

interface FakeServer {
  client: CopypartyClient;
  handshakes: number;
  chunkPosts: number;
  handshakeUrls: string[];
}

function makeFakeServer(
  entries: WalkerEntry[],
  opts: FakeServerOptions = {},
): FakeServer {
  const state = { handshakes: 0, chunkPosts: 0, handshakeUrls: [] as string[] };
  // wark → uploaded chunk hashes
  const serverSeen = new Map<string, Set<string>>();
  // name → assigned wark (stable across handshakes)
  const warkByName = new Map<string, string>();
  let nextWark = 1;
  let chunkFailuresLeft = opts.failChunkFor?.times ?? 0;
  const warkNameMap = new Map<string, string>();

  const fetchMock = vi.fn(
    async (_url: string, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? 'GET';
      if (method !== 'POST') throw new Error(`fake server: unexpected ${method}`);
      const headers = normalizeHeaders(init?.headers);
      if (!headers['x-up2k-hash']) {
        // handshake
        state.handshakes++;
        state.handshakeUrls.push(_url);
        const body = JSON.parse(init?.body as string) as {
          name: string;
          size: number;
          hash: string[];
        };
        if (opts.failHandshakeFor?.name === body.name) {
          return new Response('', { status: opts.failHandshakeFor.status });
        }
        let wark = warkByName.get(body.name);
        if (!wark) {
          wark = `wark-${nextWark++}`;
          warkByName.set(body.name, wark);
          serverSeen.set(wark, new Set());
          warkNameMap.set(wark, body.name);
          // A pre-existing file already has every chunk on the server.
          if (opts.preexisting?.includes(body.name)) {
            for (const h of body.hash) serverSeen.get(wark)!.add(h);
          }
        }
        const seen = serverSeen.get(wark)!;
        const missing = body.hash.filter((h) => !seen.has(h));
        return jsonResponse({
          name: body.name,
          purl: '',
          wark,
          hash: missing,
          sprs: true,
        });
      }
      // chunk upload
      state.chunkPosts++;
      const wark = headers['x-up2k-wark'];
      const name = warkNameMap.get(wark) ?? '';
      if (
        opts.failChunkFor?.name === name &&
        chunkFailuresLeft > 0
      ) {
        chunkFailuresLeft--;
        return new Response('', { status: opts.failChunkFor.status });
      }
      // A stitched POST carries several comma-joined chunk hashes; record each.
      const stitched = headers['x-up2k-hash'].split(',');
      for (const h of stitched) serverSeen.get(wark)?.add(h);
      return new Response('', { status: 200 });
    },
  );

  const client = new CopypartyClient({
    baseUrl: 'http://localhost:9999',
    password: 'pw',
    fetch: fetchMock as unknown as typeof fetch,
  });

  return {
    client,
    get handshakes() {
      return state.handshakes;
    },
    get chunkPosts() {
      return state.chunkPosts;
    },
    get handshakeUrls() {
      return state.handshakeUrls;
    },
  };
}

function normalizeHeaders(h: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  if (h instanceof Headers) {
    h.forEach((v, k) => (out[k.toLowerCase()] = v));
    return out;
  }
  if (Array.isArray(h)) {
    for (const [k, v] of h) out[k.toLowerCase()] = v;
    return out;
  }
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v;
  return out;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function noSleep(_ms: number): Promise<void> {
  return Promise.resolve();
}
