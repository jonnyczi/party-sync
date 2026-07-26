---
name: readme-screenshots
description: Refresh the README's light/dark screenshots (docs/screenshots/*.webp) after UI changes — stage realistic demo data on the emulator, recapture the 10 scenes, and reconvert to WebP. Use when asked to update/retake README or store-listing screenshots, or when docs/screenshots is stale.
---

# Refresh the README screenshots

Mechanics (boot, tap loop, shot.sh, clean-shot prep) live in the
`drive-emulator` skill — load it first. This skill holds the scene inventory,
data staging, and the image pipeline. First done in PR #23.

## Scene inventory (capture in this order)

Each scene = one `scripts/emu/shot.sh <slug>` call (light+dark pair).

| # | slug | screen | staging precondition |
|---|------|--------|----------------------|
| 1 | `quickstart-1-get-started` | Dashboard, Get-started card | fresh app (`pm clear` + re-grant permissions), no servers/jobs |
| 2 | `quickstart-2-add-server` | Server form + Test connection ✓ | fill: **Home NAS**, `http://10.0.2.2:3923`, `test`/`testpw`; tap Test connection |
| 3 | `quickstart-3-create-job` | New job form | name **Camera roll**, server selected, source = camera roll, remote `/phone-backups/camera`, organize **By year / month** |
| 4 | `quickstart-4-first-sync` | Dashboard after first ok sync | run the job once (seeded camera roll) |
| 5 | `schedule` | Edit-job SchedulePanel | periodic ON, every **360** min, **Wi-Fi only ON**; needs a past periodic run so "Next run: in Xh · H:MM" shows; frame from Parallel uploads → Notifications |
| 6 | `sync-active` | Dashboard mid-run hero | push a fresh batch of **~60 × ~5 MB** photos (see below), trigger sync, capture within the ~1-min window |
| 7 | `dashboard` | Dashboard hero (chart + health strip) | after backdating (below), 2 jobs all ok — **before any failure staging** |
| 8 | `jobs` | Jobs tab | both jobs green, Sync all visible |
| 9 | `run-retry` | Run detail of a partial run | `docker stop copyparty-test` → push 3 new files into Documents → sync (7 skipped / 3 failed) → open run → capture → `docker start` → tap Retry failed |
| 10 | `background-sync` | Setup checklist, battery "blocked" | fresh emulator state; capture **before** `deviceidle whitelist` |

## Data staging

- **Media**: `scripts/emu/gen-seed.sh` (needs devShell), then
  `adb push tmp/seed/. /sdcard/DCIM/Camera/`, `adb push tmp/docs-seed/. /sdcard/Documents/`,
  `adb shell content call --method scan_volume --uri content://media --arg external_primary`.
- **Second job "Documents"**: folder source via the SAF picker — tap flow
  (worked first try): Pick folder… → `Documents` tile → `USE THIS FOLDER` → `ALLOW`.
- **Mid-run batch** (scene 6): generate ~60 photos at `-size 2000x1500 -quality 99`
  with heavy `+noise` (~5 MB each). Loopback is otherwise too fast to catch —
  `adb emu network speed` and `docker pause` do NOT help.
- **Backdated run history** (scenes 5/7): `am force-stop` → pull DB
  (`adb exec-out run-as <pkg> cat files/SQLite/copyparty-client.db > tmp/stage.db`,
  plus `-wal`/`-shm` if present) → verify job ids → Python-INSERT ~7 `ok` rows
  into `runs` (`job_id, started_at, finished_at` ms-epoch, `trigger`
  manual/periodic, counters, `bytes_uploaded`, `bytes_deduped`) spread over
  distinct local days with one quiet day; keep them older than the newest real
  run → `adb push` + `run-as cp` back, delete stale `-wal`/`-shm` → relaunch.
  Schema: `src/db/schema.ts` (+ migrations for `skip_reason`, `bytes_deduped`).
  **Known wedge**: the first sync after a DB swap can fail with
  `NativeDatabase.prepareAsync has been rejected` (or a stuck spinner) —
  `am force-stop` + relaunch fixes it. `adb root` is unavailable
  (production image), so run-as is the only path.

## Image pipeline

```bash
magick tmp/shots/<slug>-<theme>.png -resize 540x -strip \
  -define webp:method=6 -quality 82 docs/screenshots/<slug>-<theme>.webp
```

Targets: ≤ ~60 KB/image (whole set ≈ 0.5 MB). 540px ≈ 2× density at the
README's `width="260"` (hero `width="300"`).

## README conventions

```html
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/<slug>-dark.webp">
  <img src="docs/screenshots/<slug>-light.webp" width="260" alt="<descriptive alt>">
</picture>
```

The light `<img>` doubles as the no-media-query fallback. Keep slugs/alt text in
sync with README.md sections when adding scenes.

## Verification

- Contact sheets: `magick <ordered pngs> -resize 216x +append tmp/sheet-<theme>.jpg`, then Read.
- After pushing a branch: `gh api repos/<owner>/<repo>/readme?ref=<branch> -H "Accept: application/vnd.github.html"`
  confirms `<picture>`/`<source>` survive GitHub's sanitizer. Eyeball both
  themes on github.com before merging. Repo is private (as of 2026-07):
  unauthenticated raw URLs 404 and dynamic shields badges show "not found" —
  the README uses static badges until it goes public.
