---
name: drive-emulator
description: Run and drive the copyparty-client app on the Android emulator — boot the AVD, build/install the dev build, tap through the UI via adb, verify changes on-screen, and take screenshots (including light/dark pairs). Use whenever asked to run/launch the app, verify a change in the emulator/simulator, screenshot a screen, or automate UI interactions.
---

# Drive the app on the Android emulator

App package: `io.github.jonnyczi.copypartyclient`. All gradle/expo commands need
the nix devShell (`nix develop --command bash -c '…'`) — see CLAUDE.md.

## Boot & build

```bash
~/Android/Sdk/emulator/emulator @Medium_Phone_API_35 -no-snapshot &   # CLI launch works on this machine
adb shell getprop sys.boot_completed        # poll until "1" (usually <1 min warm)
nix develop --command bash -c 'npm run android'   # prebuild + install + Metro; run in background
```

Keep Metro alive for the whole session — every relaunch (incl. after
`pm clear` / `am force-stop`) needs it or the app shows the red error screen.
Foreground the app: `adb shell monkey -p io.github.jonnyczi.copypartyclient -c android.intent.category.LAUNCHER 1`.

## Interaction loop

1. `scripts/emu/ui.sh` — prints every labeled node as `(x,y) Class 'label' clickable=…`.
2. Act: `adb shell input tap X Y` · `adb shell input text 'Hello%sworld'` (`%s` = space)
   · clear a field: `input keycombination 113 29` then `input keyevent 67`
   · dismiss keyboard: `input keyevent 111` · back: `input keyevent 4`
   · scroll: `input swipe 540 1800 540 600 400`.
3. **Re-dump after every navigation — never reuse coordinates across screens.**
   The Jobs list reorders by last-run time; a stale coordinate once synced the
   wrong job. Verify outcomes with a fresh dump, not by assuming the tap landed.

`uiautomator` sometimes fails with "could not get idle state" — retry once.

## Screenshots

- Light/dark pair: `scripts/emu/shot.sh <slug>` → `tmp/shots/<slug>-{light,dark}.png`.
  Theme flips in place (`cmd uimode night` + `uiMode` in configChanges) — no re-navigation.
- Quick look (token-cheap, then Read the JPEG):
  `adb exec-out screencap -p | magick png:- -resize 50% -quality 80 tmp/shot.jpg`
- Review many shots at once with `magick a.png b.png … +append sheet.jpg`
  (**not** `magick montage` — it needs a font and fails in the devShell).

## Clean shots (for docs/store listings)

- Status bar demo mode: `settings put global sysui_demo_allowed 1`, then
  `am broadcast -a com.android.systemui.demo -e command enter`, `… clock -e hhmm 0941`,
  `… battery -e level 100 -e plugged false`, `… network -e wifi show -e level 4`,
  `… notifications -e visible false`. Exit with `… -e command exit` when done.
- After `pm clear`, silence permission dialogs:
  `pm grant <pkg> android.permission.READ_MEDIA_IMAGES` (also `READ_MEDIA_VIDEO`, `POST_NOTIFICATIONS`).
- Clear the dashboard battery warning: `dumpsys deviceidle whitelist +<pkg>`.
- Dev LogBox banner ("Open debugger to view warnings") photobombs shots once any
  `console.warn` fires: temporarily add `LogBox.ignoreAllLogs(true)` to
  `index.ts` (Metro hot-reloads; app data survives) and **revert before committing**.

## Test server

`npm run test:integration:up` → copyparty on `:3923`, creds `test`/`testpw`.
In-app URL: `http://10.0.2.2:3923` (emulator alias for host loopback).
Note: loopback is fast — a full sync of ~25 MB finishes in <2 s, and neither
`adb emu network speed` nor `docker pause` slows it. To observe a sync mid-run,
stage a large batch (~60 × 5 MB files ≈ 1-min window).

## Teardown

When done: stop Metro, `adb emu kill`, `npm run test:integration:down`
(project rule: stop the dev environment you started).
