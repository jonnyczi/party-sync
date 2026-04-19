# Plan: Test buttons on Server and Job config screens

## Context

Today the only way to discover a bad server/job config is to tap **Sync now** and wait for the engine to fail somewhere in the middle of a run. That's a poor feedback loop for first-time setup and for diagnosing a moved folder or a revoked password.

We want two **Test** buttons that give immediate, pre-flight validation against the live copyparty server:

- **Server test** — verifies the base URL is reachable, TLS/cert pin (if set) is satisfied, and the `PW` header is accepted.
- **Job test** — verifies the configured remote path exists, the authenticated user has **write** permission on it, and the local SAF folder URI is still accessible.

The two tests are complementary, not redundant: the server test can pass while the job test fails (e.g. path typo, user has read but not write on that volume, SAF permission revoked).

Both buttons run against the **current form values** (pre-save), falling back to the stored secret when the password field is blank during an edit. Result is surfaced via `Alert.alert()` matching the existing error-display pattern in the app.

## Approach

### 1. Add a lightweight `?ls` call to `CopypartyClient`

`src/copyparty/client.ts` currently only exposes `handshake()` and `uploadChunk()`. Both test buttons need a read-only GET that returns folder info + `perms`. Add:

```ts
async listFolder(folderPath: string): Promise<LsResponse>
```

- Method: `GET`
- URL: `folderUrl(folderPath) + '?ls'` (the client's existing `folderUrl()` handles the trailing slash).
- Headers: `PW` header via the existing private `headers()` helper.
- On non-2xx: throw `Up2kError` with phase `'ls'` and the HTTP status, mirroring `handshake()`.
- Returns: `LsResponse` shape defined in `src/copyparty/types.ts`:
  ```ts
  export interface LsResponse {
    perms: string[];   // e.g. ["read","write","get"]
    files: { href: string; sz: number; ts: number }[];
    dirs:  { href: string; sz: number; ts: number }[];
    // other fields ignored for v1
  }
  ```
  Confirmed from copyparty source `httpcli.py:6661` / `:7066` — response carries `perms` as a string array.

Add `'ls'` to the `Up2kError` `phase` union in `src/copyparty/types.ts`.

### 2. New shared helper `src/copyparty/test-connection.ts`

Single source of truth for both test buttons. Two exported async functions:

```ts
export async function testServerConnection(opts: {
  baseUrl: string;
  password: string;
  certSha256?: string | null;
}): Promise<void>                         // resolves on success, throws TestError

export async function testJobConnection(opts: {
  baseUrl: string;
  password: string;
  certSha256?: string | null;
  remotePath: string;
  sourceUri?: string;                     // SAF URI; when present, probed too
}): Promise<{ remoteOk: true; localOk: boolean }>
```

Each function:

- Instantiates `CopypartyClient`. (Cert-pin `fetchInit` wiring is out of scope for v1 tests — the app doesn't wire it for real requests yet either; see "Out of scope" below.)
- `testServerConnection` calls `client.listFolder('/')` — this one request validates reachability, TLS, and auth. No write check at the root.
- `testJobConnection` calls `client.listFolder(remotePath)`; on success, asserts `resp.perms.includes('write')`. If `sourceUri` is provided, also calls `FileSystem.StorageAccessFramework.readDirectoryAsync(sourceUri)` and catches — a throw means the SAF grant is gone.

Error classification — map to user-friendly messages:

| Cause | Message |
|---|---|
| `TypeError` / `AbortError` / DNS fail | "Server unreachable. Check the URL and your network." |
| `Up2kError` with `httpStatus === 401` | "Authentication failed. Check username/password." |
| `Up2kError` with `httpStatus === 403` | "Access denied for this path." (job test only — server root shouldn't 403 with valid auth) |
| `Up2kError` with `httpStatus === 404` | "Remote path not found: `<remotePath>`." |
| `Up2kError` other 4xx/5xx | "Server error: HTTP `<status>`." |
| `perms` missing `'write'` | "You have read-only access to `<remotePath>`. Uploads won't work." |
| SAF read throws | "Local folder is no longer accessible. Re-pick the folder." |

Use a small `TestError extends Error` with a `.kind` discriminator; the screen handlers just pass `err.message` into `Alert.alert`.

### 3. Wire the button into `app/server/[id].tsx`

Location: inline Pressable **above** the existing `Delete server` button (see user-approved preview). On **New server** screens, it appears above the bottom padding; the delete block is hidden in the new case so nothing shifts.

State:

```ts
const [testing, setTesting] = useState(false);
```

Handler:

```ts
const onTest = async () => {
  if (testing) return;
  setTesting(true);
  try {
    // Password: prefer the form value; fall back to stored secret on edit.
    let pw = password;
    if (!pw && !isNew && serverId !== null) {
      pw = (await getServerPassword(serverId)) ?? '';
    }
    if (!pw) { Alert.alert('Test failed', 'Password is required.'); return; }
    if (!/^https?:\/\//i.test(baseUrl.trim())) {
      Alert.alert('Test failed', 'URL must start with http:// or https://.');
      return;
    }
    await testServerConnection({
      baseUrl: normalizeBaseUrl(baseUrl),
      password: pw,
      certSha256: certSha.trim() ? normalizeFingerprint(certSha) : null,
    });
    Alert.alert('Connection OK', 'Server responded and auth was accepted.');
  } catch (e) {
    Alert.alert('Test failed', e instanceof Error ? e.message : String(e));
  } finally {
    setTesting(false);
  }
};
```

Disabled state: `testing || baseUrl.trim().length === 0`. Button label flips between `Test connection` and `Testing…`, optionally with a small `ActivityIndicator` next to it.

Add `getServerPassword` to the existing import block from `@/src/storage/secrets`.

### 4. Wire the button into `app/job/[id].tsx`

Location: inline Pressable **below the `Remote path` field** and **above the existing `Sync now` block** on edit screens; on `New job` (where there's no Sync section yet) it sits above the bottom padding.

State + handler mirror the server test, with these differences:

- Loads the stored password via `getServerPassword(serverId)` regardless of form state (the job screen has no password input — it always needs the secret from secure-store for the selected server).
- Derives `baseUrl` + `certSha256` from the selected `ServerRow` in state (not re-fetched — `servers` is already populated on mount).
- Calls `testJobConnection({ baseUrl, password, certSha256, remotePath: normalizeRemotePath(remotePath), sourceUri })`.
- Success alert: `'OK — remote path writable, local folder accessible.'` If `localOk === false`: `'Remote OK, but local folder permission is gone — re-pick it.'` (still classed as a failure-to-sync, surfaced as a warning Alert).
- Disabled state: `testing || !serverId || remotePath.trim().length === 0`.

### 5. Tests

Add `tests/integration/test-connection.test.ts` (runs against the dockerized copyparty; reuses `helpers.ts` for credentials):

- `testServerConnection` — correct creds → resolves; wrong password → throws with 401 message; unreachable host → throws unreachable message.
- `testJobConnection` — existing folder with `test` user (which has `A` = all perms) → resolves with `remoteOk: true`; nonexistent path → 404 message; read-only path (requires adding a read-only volume to `tests/docker-compose.yml`) — **skip in v1**, comment with a TODO rather than expand the compose file now.

No unit tests for the UI (matches project convention — `tests/unit/` has no RN component tests today).

## Critical files to modify / create

- `src/copyparty/client.ts` — add `listFolder()`
- `src/copyparty/types.ts` — add `LsResponse`, extend `Up2kError` `phase` union with `'ls'`
- `src/copyparty/test-connection.ts` — **new** — shared helpers + error mapping
- `app/server/[id].tsx` — add Test button + handler
- `app/job/[id].tsx` — add Test button + handler
- `tests/integration/test-connection.test.ts` — **new**

Reused as-is:
- `CopypartyClient` + `Up2kError` (`src/copyparty/client.ts`, `types.ts`)
- `getServerPassword` (`src/storage/secrets.ts`)
- `Alert.alert` pattern (already used on both screens for Save failures)
- `normalizeBaseUrl`, `normalizeFingerprint`, `normalizeRemotePath` local helpers in each screen
- `StorageAccessFramework.readDirectoryAsync` from `expo-file-system/legacy` (already imported in job screen for `pickFolder`)

## Out of scope (flagged, not in this change)

- **Cert-pin enforcement during the test**: the app's existing requests don't verify the pinned fingerprint on-device yet (v1 relies on system trust; `cert_sha256` is stored but not wired into fetch). The test button will reflect whatever the platform `fetch` does — matching real sync behavior. Wiring true pinning is a separate task.
- **Write-probe fallback**: copyparty's `?ls` `perms` field is reliable (confirmed at `httpcli.py:6661`), so no need for a marker-file probe.
- **Inline status chips** (green "Connected" / red banner): rejected in favor of the Alert pattern that's already used app-wide.

## Verification

1. `nix develop --command bash -c 'npm run test:integration:up'` to start the dockerized copyparty.
2. `nix develop --command bash -c 'npm run test:integration'` — new `test-connection.test.ts` exercises server + job happy paths and auth/404 failures.
3. Manual on the Android emulator (`npm run android` inside `nix develop`):
   - New server, URL `http://10.0.2.2:3923`, user `test`, pw `testpw` → tap Test → Alert "Connection OK".
   - Edit server, clear password field, tap Test → succeeds (falls back to secure-store).
   - Edit server, wrong password → Alert "Authentication failed."
   - Stop docker container, tap Test → Alert "Server unreachable."
   - New job on that server, remote `/` (writable for `test` in compose) → Alert "OK — remote path writable…".
   - Same job with remote `/does-not-exist` → Alert "Remote path not found: /does-not-exist."
   - Uninstall app, reinstall, edit an existing job (SAF permission gone), tap Test → Alert "Local folder is no longer accessible."
4. Confirm no regressions to Save / Sync-now paths on both screens.
