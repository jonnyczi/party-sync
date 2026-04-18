# copyparty mobile client — initial implementation plan

## Context

We're building an Android-first (iOS-safe later) mobile client whose sole job is to reliably sync user-configured local directories to a copyparty server on a recurring basis. Think "backup/upload agent with a UI," not a general file browser.

The repo already ships as Expo Router + RN 0.81 + React 19 + Expo SDK 54 + New Architecture + Reanimated v4. We stay inside that stack. The hard constraint is protocol parity: the client MUST speak copyparty's **up2k** protocol (hashed-chunk handshake + resumable chunk upload) identically to copyparty's own web client — no invented protocol.

Key user-confirmed product decisions:

- **Multiple servers** per install. Each sync job = `(server, local source, remote path)`.
- **One-way push, mirror** — additive by default, with a **per-job toggle** for delete propagation.
- **Triggers (v1 intent)**: manual button, periodic background, charging + Wi‑Fi constraints, on-change observer (media only, realistically). v1 ships **manual only**; periodic/observer arrive in later phases.
- **Content sources**: both SAF-picked folders AND a dedicated camera-roll job type (MediaLibrary).
- **Remote path**: user picks explicit remote path per job (no auto-derivation).
- **Failure policy**: skip failures, continue, report at end; retry on next run with backoff.
- **UI**: single dashboard + separate jobs tab.
- **Distribution**: EAS Build + custom dev client from day one (we can't stay in Expo Go).
- **Change detection**: hybrid — `(path, size, mtime)` short-circuit on every run; periodic forced full re-hash catches mtime lies.
- **Local DB**: `expo-sqlite`.
- **v1 scope**: servers CRUD, jobs CRUD (SAF + camera roll), manual sync with live progress and per-file error surfacing.

---

## Protocol spec (up2k)

Confirmed against `/tmp/copyparty` clone. Cite-everything:

### Chunking

- Deterministic chunk size based on file size. Port `up2k_chunksize(filesize)` verbatim from `copyparty/up2k.py:5698`.
- Base = 1 MiB. Grows (1.5, 2, 3, 4 … MiB) until `ceil(size/chunk) ≤ 256`, or once chunk ≥ 32 MiB, until `≤ 4096` chunks. Full table: `docs/devnotes.md:109-138`.
- Chunks can be **stitched** (multiple consecutive chunks in one POST, hashes comma-joined in header) and **subchunked** (partial chunk offsets via `X-Up2k-Subc`). v1 implementation: send one chunk per POST; add stitching only if we measure throughput benefit.

### Hashing

- **SHA-512** per chunk (`copyparty/web/up2k.js:2246` — `subtle.digest('SHA-512', buf)` or `hashwasm.sha512` fallback at `:2250`).
- Hash encoding is **base64url (no padding)**, standard URL-safe alphabet. Implementation at `up2k.js:2033-2068` (`buf2b64`).
- Hash length per chunk = **43 chars** (256 bits). copyparty **truncates** the 512-bit SHA-512 to 32 bytes before base64url-encoding (confirmed by wire samples in `docs/up2k.txt:6,10-12,88-94`, which are exactly 43 chars each). Implementation detail to verify during impl: grep `buf2b64` call sites for slice length.
- The full list of chunk hashes (in order) is sent in the handshake. The server derives the **wark** (session id) from `sha512(salt + filesize + chunk_hashes)` — we don't generate it; we receive it.

### Handshake

- **Method**: `POST`
- **URL**: the target folder's URL on the server (e.g. `https://host/vol/sub/`). Upload endpoint is whichever volume the user configured the job to point at.
- **Content-Type**: `application/json` (copyparty also accepts `text/plain;charset=UTF-8` for CORS simple requests; we use JSON).
- **Body**:
  ```json
  { "name": "<filename>", "size": <int>, "lmod": <unix_seconds>, "hash": ["<b64url>", "<b64url>", …] }
  ```
  Optional `"srch": 1` for dedup-only lookups (server returns `hits` instead of creating an upload slot).
- **Response**: `{ "name", "purl", "wark", "hash": [<missing chunk hashes>], "sprs": <bool>, "fk"? }`  (see `up2k.js:2580-2622`).
  - `hash` array = chunks the server still needs. Empty array means file is complete.
  - Server may **rename** (`name`) or assign a **file key** (`fk`) — client must follow.
- **Search-mode response** when `srch:1`: `{ "hits": [{ "rp": "<remote path>", "ts": <unix> }, …] }` or `404` if nothing found (`up2k.js:2545-2568`).

### Chunk upload

- **Method**: `POST`
- **URL**: same folder URL as handshake.
- **Headers** (`up2k.js:2995-3006`):
  - `Content-Type: application/octet-stream`
  - `X-Up2k-Hash: <hash1>[,<hash2>,…]`  — one or more consecutive chunk hashes (stitching)
  - `X-Up2k-Wark: <wark from handshake>`
  - `X-Up2k-Subc: <byte offset>` — only when sending a partial chunk (subchunk)
  - `X-Up2k-Stat: <text>` — optional progress/telemetry for the server log; we send a simple form
- **Body**: raw bytes of the chunk(s), in order. `Content-Length` = sum of chunk sizes.
- **Response**: 200 OK on write success. Server writes each chunk at its hash-determined offset in a sparse file.

### Finalization

- After all chunks are POSTed, client **re-POSTs the handshake** with the same body. If the server now has every chunk, response `hash: []` and the file is moved into place (`up2k.py` registry logic, `docs/up2k.txt:31-33`). If any chunk failed hash verification, response `hash` lists those chunks for retry.

### Auth

copyparty accepts (first non-blank wins, `docs/devnotes.md:158-162`):

1. URL param `?pw=<pass>`
2. Header `PW: <pass>`
3. HTTP Basic auth
4. Cookie `cppwd=<pass>` (http) / `cppws=<pass>` (https)

**Our choice: `PW` header.** It avoids URL-leak logging, works for both GET/POST trivially, and needs no cookie state. Password stored in `expo-secure-store` (Android Keystore-backed). Per-volume passwords are the same as per-server passwords in copyparty; we expose one password per server, which is the normal model.

### Listing / existence check

- `GET <remote-path>?ls` — JSON folder listing. Use when the delete-propagation option is on (need to know what's on the server to know what to delete).
- The handshake itself is the canonical "does the server already have this?" check — if all chunks match, server responds `hash: []` immediately, no bytes uploaded.

### Mobile gotchas (flagged)

- **Pre-upload hashing is mandatory** — we cannot send a single byte before every chunk is hashed and listed. For a 4 GB video on an average phone this is minutes of CPU. We run hashing in a native module, not JS.
- `Content-Length` must be exact for chunk POSTs; streaming an unknown-length body will break the server's `readinto` loop.
- Request timeout on chunk POST: copyparty's web client uses 34s for handshake; chunk uploads scale with network. We'll use long timeouts and rely on TCP keepalive / retry-on-failure rather than hard timeouts.
- TLS trust: copyparty deployments often use self-signed certs on LAN. We expose a per-server "trust certificate fingerprint" option (manual confirmation on first connect).

---

## Architecture

```
app/                              (Expo Router — screens only)
  (tabs)/
    index.tsx                     dashboard (active run, last run, errors, aggregate)
    jobs.tsx                      sync-job list + "new job" entry point
    settings.tsx                  global prefs + servers list
  job/[id].tsx                    job detail, run history, manual run button
  server/[id].tsx                 server edit (name, url, password, cert trust)
  _layout.tsx                     (existing)

src/
  copyparty/
    client.ts                     fetch wrapper: base URL, PW header, cert handling, retries
    up2k.ts                       protocol state machine (handshake → chunks → re-handshake)
    chunksize.ts                  port of up2k_chunksize() from up2k.py
    hash.ts                       thin wrapper over native SHA-512 module
    types.ts                      HandshakeBody, HandshakeResponse, etc.
  sync/
    engine.ts                     run a sync job: enumerate → diff → hash → upload → record
    walker/
      saf.ts                      walk a SAF-granted tree via expo-file-system
      media.ts                    enumerate camera roll via expo-media-library
    triggers/
      manual.ts                   button → engine.run(jobId)
      periodic.ts                 (phase 6) WorkManager via expo-background-task
      observer.ts                 (phase 7) MediaStore ContentObserver (camera roll only)
    progress.ts                   typed event bus; screens subscribe via useSyncExternalStore
  db/
    schema.ts                     SQL DDL + migrations
    servers.ts                    DAO
    jobs.ts                       DAO
    file_state.ts                 DAO for the (job, path, size, mtime, hash, uploaded_at) table
    runs.ts                       DAO for run history + errors
  storage/
    secrets.ts                    expo-secure-store wrappers (passwords only)
  ui/
    components/                   shared UI (status chips, progress bars, etc.)

modules/
  copyparty-sha512/               Expo Native Module — streaming SHA-512 for Android
    src/
      index.ts                    TS binding
    android/
      src/main/java/…/Sha512Module.kt   MessageDigest("SHA-512") over ContentResolver InputStream
```

### Library choices

- `expo-sqlite` — local state DB (chosen).
- `expo-secure-store` — passwords at rest (Android Keystore).
- `expo-file-system` — SAF tree walking and file reads on Android (supports `content://` URIs and `StorageAccessFramework`).
- `expo-media-library` — camera-roll enumeration and (later) `ContentObserver` bridge.
- `expo-background-task` + `expo-task-manager` — WorkManager-backed periodic triggers (phase 6).
- `expo-notifications` — foreground-service notification for long runs (phase 6).
- **Custom native module** `copyparty-sha512` — streams SHA-512 over a file path or `content://` URI, emits base64url chunk hashes directly (Kotlin, `java.security.MessageDigest` + `ContentResolver.openInputStream`). Reasoning: `expo-crypto` has no streaming digest API, and pulling multi-GB files into JS to hash is a non-starter. Native keeps memory flat and is ~an order of magnitude faster than JS SHA-512.

No state-management library for v1 — SQLite + `useSyncExternalStore` over a small event bus is enough. Revisit if screens get complicated.

---

## Data model (SQLite)

```sql
-- one row per configured server
CREATE TABLE servers (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL,
  base_url     TEXT NOT NULL,          -- e.g. https://copyparty.local:3923
  username     TEXT,                   -- optional, for display only (copyparty uses password-only)
  cert_sha256  TEXT,                   -- pinned fingerprint for self-signed certs; NULL = system trust
  created_at   INTEGER NOT NULL
);
-- password lives in expo-secure-store under key `server:<id>:pw`, NOT in sqlite

CREATE TABLE jobs (
  id                    INTEGER PRIMARY KEY,
  server_id             INTEGER NOT NULL REFERENCES servers(id),
  name                  TEXT NOT NULL,
  source_kind           TEXT NOT NULL CHECK (source_kind IN ('saf','media')),
  source_uri            TEXT NOT NULL,       -- SAF tree URI, or media bucket id
  remote_path           TEXT NOT NULL,       -- e.g. /phone-backups/jonny/camera
  propagate_deletes     INTEGER NOT NULL DEFAULT 0,
  wifi_only             INTEGER NOT NULL DEFAULT 1,
  respect_data_saver    INTEGER NOT NULL DEFAULT 1,
  charging_only         INTEGER NOT NULL DEFAULT 0,
  rehash_interval_days  INTEGER NOT NULL DEFAULT 30,
  created_at            INTEGER NOT NULL,
  last_run_id           INTEGER REFERENCES runs(id)
);

-- memoized change-detection state; one row per observed source file per job
CREATE TABLE file_state (
  job_id          INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  local_path      TEXT NOT NULL,           -- canonical key within the job (URI or relative path)
  size            INTEGER NOT NULL,
  mtime_ms        INTEGER NOT NULL,
  wark            TEXT,                    -- last successful wark (for debugging)
  last_hashed_at  INTEGER,                 -- when we last fully hashed this file
  uploaded_at     INTEGER,                 -- when server confirmed complete
  PRIMARY KEY (job_id, local_path)
);

CREATE TABLE runs (
  id           INTEGER PRIMARY KEY,
  job_id       INTEGER NOT NULL REFERENCES jobs(id),
  started_at   INTEGER NOT NULL,
  finished_at  INTEGER,
  trigger      TEXT NOT NULL,             -- 'manual' | 'periodic' | 'observer'
  status       TEXT NOT NULL,             -- 'running' | 'ok' | 'partial' | 'failed'
  files_scanned   INTEGER NOT NULL DEFAULT 0,
  files_uploaded  INTEGER NOT NULL DEFAULT 0,
  files_skipped   INTEGER NOT NULL DEFAULT 0,
  files_failed    INTEGER NOT NULL DEFAULT 0,
  bytes_uploaded  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE run_errors (
  id          INTEGER PRIMARY KEY,
  run_id      INTEGER NOT NULL REFERENCES runs(id),
  local_path  TEXT NOT NULL,
  phase       TEXT NOT NULL,              -- 'stat' | 'hash' | 'handshake' | 'upload' | 'finalize'
  http_status INTEGER,
  message     TEXT
);
```

All writes go through DAOs; UI reads via live queries (re-query on run-tick events from `progress.ts`).

---

## Sync pipeline (per job run)

1. **Gate** — check triggers' constraints (wifi? charging? data saver?). Bail early with `skipped` status if not satisfied.
2. **Enumerate** — walk the source via `saf.ts` or `media.ts`, yielding `(local_path, size, mtime_ms)` tuples.
3. **Diff** — for each tuple, look up `file_state`. Produce three buckets:
   - **Unchanged**: `(size, mtime)` match AND `last_hashed_at` within `rehash_interval_days`. Skip.
   - **Needs re-hash**: interval exceeded — hash and compare against stored wark; upload only if changed.
   - **New or changed**: hash and upload.
4. **Hash** — native module streams SHA-512 per chunk (chunk size from `up2k_chunksize(size)`), returns ordered base64url list.
5. **Handshake** — POST to remote folder URL. If response `hash: []` — file already there (dedup hit). Record `uploaded_at = now`, skip to step 8.
6. **Upload chunks** — for each hash in response `hash[]`, POST the corresponding chunk range from source stream. Concurrency: **2 in flight** for v1 (tune later). Retry each POST with exponential backoff on 5xx / network errors; mark `files_failed` after N retries and continue.
7. **Re-handshake** — confirm `hash: []`. If not empty, loop back to step 6 with the new missing list. Guard against infinite loop with a max-iteration cap.
8. **Record** — upsert `file_state`, bump run counters, emit progress event.
9. **Delete-propagation** (only if `propagate_deletes=1`) — after all uploads: `GET remote?ls`, diff against enumerated locals, `POST ?delete` for files on the server that we previously uploaded (`file_state` has a row) but that no longer exist locally. Never delete files we didn't originate.
10. **Finalize run** — write `runs.finished_at`, set status from counters, emit final progress event.

Per-file errors are non-fatal; they land in `run_errors` and the dashboard surfaces them. Runs only fail wholesale on auth errors (401), config errors (404 of target folder), or unreachable-server.

---

## Background execution strategy (summary, details deferred to phase 6)

- **v1 runs in the foreground only** — user taps "Sync now", app holds a foreground service notification for the duration so the OS doesn't kill us under Doze.
- **Phase 6** introduces `expo-background-task` (WorkManager under the hood) for periodic triggers with constraints (unmetered network, charging). Each periodic tick just calls `engine.run(jobId)` for every eligible job.
- **Phase 7** adds a `ContentObserver` bridge for media (camera roll). SAF tree watching is **not** planned — Android does not provide reliable change notifications for arbitrary user-granted trees; those jobs stay on manual+periodic only.

---

## Phased delivery

| Phase | Deliverable | Demo |
|---|---|---|
| 1 | Protocol core: `up2k.ts` + `chunksize.ts` + `copyparty-sha512` native module + unit tests against a local copyparty in Docker | Upload one file via a test harness |
| 2 | SQLite schema + migrations + DAOs + secure-store wiring | `settings.tsx` + `server/[id].tsx` CRUD |
| 3 | SAF source + manual job run | Create a job, tap sync, watch progress |
| 4 | Camera roll source via expo-media-library | Same, for camera roll |
| 5 | Dashboard with live progress + per-file error list | `(tabs)/index.tsx` polished |
| 6 | Periodic background triggers + constraints + foreground service | App closed, sync runs overnight |
| 7 | MediaStore `ContentObserver` for on-change camera-roll sync | Take a photo → app notices |
| 8 | Periodic full re-hash scheduler + delete-propagation | Toggle delete propagation, delete local file, next run deletes remote |

**v1 ship bar** = phases 1–5 (matches user's "v1 scope" answers).

---

## Critical files to create / modify

- `modules/copyparty-sha512/` — new Expo native module (scaffold with `npx create-expo-module --local`)
- `src/copyparty/{client,up2k,chunksize,hash,types}.ts` — new
- `src/db/schema.ts` — new; run migrations on first app launch
- `src/sync/engine.ts` — new orchestrator
- `src/sync/walker/{saf,media}.ts` — new
- `src/storage/secrets.ts` — new
- `app/(tabs)/{index,jobs,settings}.tsx` — replace starter screens
- `app/{job,server}/[id].tsx` — new routes
- `app/_layout.tsx` — extend to register task manager (phase 6)
- `app.json` — add Android permissions (`READ_MEDIA_IMAGES`, `READ_MEDIA_VIDEO`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_DATA_SYNC`, `POST_NOTIFICATIONS`, `ACCESS_NETWORK_STATE`); add EAS Build config
- `package.json` — add `expo-sqlite`, `expo-secure-store`, `expo-file-system`, `expo-media-library`, `expo-background-task`, `expo-task-manager`, `expo-notifications`

Nothing is reused from the existing starter except `constants/theme.ts`, `ThemedText`, `ThemedView`, the root `_layout.tsx`. Starter tab screens (`index.tsx`, `explore.tsx`, `modal.tsx`) get replaced.

---

## Verification

- **Protocol**: run copyparty locally in Docker (`docker run -p 3923:3923 copyparty/ac`). Integration tests for `up2k.ts` hit `http://10.0.2.2:3923` from the Android emulator, covering: fresh upload, dedup hit, interrupted upload resume, corrupted chunk re-upload, auth failure, missing folder.
- **Hash parity**: pick 3 reference files (1 KB, 10 MB, 1 GB), hash with copyparty's CLI uploader (`bin/u2c.py` in the copyparty repo), compare our base64url chunk list byte-for-byte.
- **End-to-end on device**: EAS `development` build on a physical Android phone; create a server pointing at LAN copyparty; create one SAF folder job + one camera-roll job; run manual sync; verify files land at the configured remote paths, `file_state` populates, a second run skips everything (dedup).
- **Failure surfacing**: force a failure (point at a folder the user has no write access to, unplug Wi‑Fi mid-upload) and verify `run_errors` populates and the dashboard shows it.
- **No test runner is configured in the repo** — we add one alongside phase 1. Proposal: `bun:test` or `vitest` for pure-TS modules (`chunksize`, `hash` stubs, protocol shapes); Detox or manual physical-device testing for the UI and native module.

---

## Open decisions flagged for sign-off

- **Auth**: proposed `PW` header + secure-store. Alternatives exist (Basic, cookie, query param) if the user's deployment uses reverse proxies that strip custom headers.
- **Hashing**: proposed custom Android-only native module. Alternative would be `hashwasm` in JS — simpler build, but requires us to read file bytes into JS and costs ~3–5× CPU on large files. Native is the right call for a "backup agent" that will routinely see multi-GB videos.
- **Chunk upload concurrency**: starting at 2 for v1. copyparty's web client ramps higher; we should A/B test on a real LAN before fixing a number.
- **Stitching / subchunks**: skipped in v1. Revisit after throughput measurement.
- **iOS**: architecture is iOS-safe (swap `modules/copyparty-sha512/android` for a matching `ios/` Swift impl; `expo-file-system`/`expo-media-library`/`expo-background-task` are cross-platform). No iOS work in v1.
