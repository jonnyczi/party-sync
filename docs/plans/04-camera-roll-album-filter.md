# Plan 4 — Camera-roll album filtering

**Branch:** `feat/album-filter`
**Order:** Independent of Plans 1–3 (touches the media walker + job editor, no
engine coupling). Sequenced here to keep branches from colliding; can be built any
time once Plan 1 is merged if you want to avoid rebasing the job editor.

> ### Read first — shared context
> - **Android-first**; the camera-roll path (`expo-media-library` +
>   `modules/copyparty-sha512`) is Android-only.
> - **Never hand-edit `android/`**; native config flows through `app.json`.
> - **De-Googled**: no Firebase/GMS; `scripts/scan-nonfree-apk.py` is a CI gate.
> - **Verify in the Android emulator** before committing (the emulator needs some
>   albums populated — add a few photos to different albums first).
> - Run `npm run lint` and `npm test` before the PR.
>
> **Before coding, ask the user the "Open questions" at the bottom.**

## Context / why

A camera-roll job currently backs up **all photos and videos** — the job editor
shows a hardcoded "All photos and videos" and the media walker only accepts the
`source_uri` sentinel `'all'` (`MEDIA_SOURCE_ALL` in `src/sync/walker/media.ts`,
which already reserves room for an `album:<bucketId>` form). "Back up Camera only,
not screenshots/WhatsApp/memes" is one of the most common real-world requests.

## Locked decision

- **Single album.** Store `source_uri = 'album:<bucketId>'` (vs the existing
  `'all'`). **No schema change** — `source_uri` already carries this string.

## Key files / what changes

- **`src/sync/walker/media.ts`** — parse the `album:<id>` sentinel. When present,
  pass the album to `MediaLibrary.getAssetsAsync({ album, first, after,
  mediaType: ['photo','video'] })` (the `album` option takes an album id or an
  `Album` object). Keep the `'all'` path exactly as-is, plus the existing
  pagination, the per-asset `size()` call, and the MediaStore content-URI key
  logic (`mediaStoreUri`) — those are unchanged. Update the `walkMedia` guard that
  currently throws for any `source_uri !== MEDIA_SOURCE_ALL`.
- **`app/job/[id].tsx`** — replace the hardcoded "Camera roll scope" display with
  an album picker: list albums via `MediaLibrary.getAlbumsAsync()` and let the
  user choose **All photos & videos** (→ `'all'`) or **one album** (→
  `'album:<id>'`). Store the chosen sentinel in `sourceUri`. For display, resolve
  the album **name** from the stored id (the sentinel only holds the id), with a
  fallback label (e.g. "(album)") when the album can't be resolved. Respect the
  existing rule that source kind is locked after creation; album selection is a
  property of the media source — confirm whether the album itself is editable
  after creation (open question).
- **Inline doc** — mirror the existing content-URI stability comment: if an
  album's bucket id changes, the job falls back to "everything looks new" on the
  next run, which is correctness-preserving (re-uploads dedup server-side via
  up2k). Note it so it's not mistaken for a bug.

## Reuse

The `mediaWalker` singleton + `createMediaWalker(library, sizer)` DI seam in
`src/sync/walker/media.ts` (already built so unit tests inject a mock library —
use it to test album forwarding without `expo-media-library`). The job editor's
existing field/segmented-control patterns.

## Open questions for this session

1. **Stored key** — album **id** (stable-ish but opaque) vs **name** (readable but
   can rename/collide). Suggest id, resolve name for display.
2. **Missing album at run time** (album deleted/emptied since the job was saved) —
   surface a clear run-level error, or treat as an empty run (0 scanned)? Suggest
   a clear error so the user notices.
3. Should the picker show **per-album asset counts** (nice UX, but costs an extra
   `getAssetsAsync` per album)?
4. Is the album **editable after job creation**, or locked like source kind?
   (Album is just a filter, so editing is safe — confirm.)
5. iOS is out of scope (the hashing module is Android-only) — confirm the picker
   simply isn't reached on iOS rather than needing a guard.

## Verification

- **Unit (`npm test`):** `createMediaWalker` with a mock `MediaLibraryLike`
  asserting (a) `'all'` still enumerates everything, and (b) `'album:<id>'`
  forwards the `album` arg and yields only that album's assets.
- **Emulator:** add photos to two albums; create a camera-roll job scoped to one;
  sync; verify only that album's files land on the server
  (`curl -u test:testpw ".../?ls=..."`). Confirm an "All" job still uploads
  everything.
