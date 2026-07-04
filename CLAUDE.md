# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm start` / `npx expo start` — start the Expo dev server (Metro bundler); opens a menu to launch iOS simulator, Android emulator, web, or Expo Go.
- `npm run android` / `npm run ios` — `expo run:<platform>`: prebuild + native compile + install dev build on emulator/simulator + start Metro. The project uses native modules (`modules/copyparty-sha512`), so Expo Go is not an option. Android requires the dev shell: see "Native Android dev environment" below.
- `npm run web` — `expo start --web`.
- `npm run lint` — runs `expo lint` (ESLint via `eslint-config-expo/flat`).
- `npm run reset-project` — **destructive**: moves or deletes `app/`, `components/`, `hooks/`, `constants/`, `scripts/` (optionally into `app-example/`) and scaffolds a blank `app/`. Only run when the user explicitly asks to reset the template.
- `npm test` / `npm run test:watch` — vitest unit tests (anything under `tests/unit/`).
- `npm run test:integration:up` / `:down` / `npm run test:integration` — bring up / tear down the Dockerized copyparty and run the integration suite against it (see "Testing against a copyparty server" below).
- `npm run bump-version <patch|minor|major|X.Y.Z>` — bump the version + Android `versionCode` (single source of truth: `app.json`; keeps `package.json` in sync). `--check vX.Y.Z` / `--print` modes too.
- `dagger call build-apk export --path ./out/app.apk` — reproducible **release** APK built in a `nixos/nix` container (only Docker needed, no Nix/SDK on host). Also `build-aab`, `lint`, `test`. See "Release pipeline" below and `docs/release-pipeline.md`.

## Native Android dev environment (NixOS)

The project includes `flake.nix` providing a reproducible Android build toolchain. The Android emulator + AVDs stay on the host (managed via Android Studio); the flake only covers what's needed to compile a dev build.

**Quick start** (from the repo root):

```
nix develop
npx expo run:android        # or `npm run android` from inside the shell
```

**What the dev shell provides**: JDK 17, Gradle 8.14.x, Android SDK platforms 35 + 36, build-tools 35.0.0 + 36.0.0, NDK 27.1.12297006, CMake 3.22.1. Platform 35 is required because `modules/copyparty-sha512`'s `expo-module-gradle-plugin` defaults `compileSdkVersion` to 35 when no version catalog overrides it; everything else uses 36.

**What stays on the host**: the Android emulator and AVDs. The flake intentionally omits `includeEmulator`/`includeSystemImages` to keep its closure small.

Launching an AVD on NixOS: the SDK's `emulator` binary is an unpatched FHS ELF and fails from a plain shell with `libX11.so.6: cannot open shared object file`. Two working options:

- **Preferred:** launch the AVD from Android Studio's Device Manager; confirm with `adb devices`.
- Or add the runtime libs to `programs.nix-ld.libraries` in `~/nixos/hosts/<host>/configuration.nix` (`nix-ld` is already enabled on this machine) — `xorg.libX11`, `xorg.libXcomposite`, `xorg.libXcursor`, `xorg.libXdamage`, `xorg.libXext`, `xorg.libXfixes`, `xorg.libXi`, `xorg.libXrandr`, `xorg.libXrender`, `xorg.libXtst`, `xorg.libxcb`, `xorg.libICE`, `xorg.libSM`, `libGL`, `libdrm`, `mesa`, `libxkbcommon`, `fontconfig`, `freetype`, `glib`, `gtk3`, `dbus`, `nss`, `nspr`, `alsa-lib`, `libpulseaudio`, `systemd`, `zlib`, `stdenv.cc.cc.lib`. After `nixos-rebuild switch`, `emulator @<AVD>` works from any shell.

**Host prerequisite (this machine only)**: a symlink so the macOS-style PATH entries resolve to the Linux SDK location:

```
mkdir -p ~/Library/Android && ln -sfn ~/Android/Sdk ~/Library/Android/sdk
```

Other contributors with a standard Linux SDK path don't need this.

**Gradle wrapper hardening**: the `shellHook` in `flake.nix` automatically (a) bumps the wrapper's `networkTimeout` from the prebuild default (10s) to 600s and (b) primes `~/.gradle/wrapper/dists/...` with the Gradle distribution zip + `.ok` marker on first shell entry. If priming fails (network), the shell prints the exact `curl` command to retry.

**`flake.lock` is committed** — pins `nixpkgs` (currently `nixos-25.11`) so all clones get identical store paths.

## Running commands that need the Android toolchain

A plain shell inside this repo reports `IN_NIX_SHELL=impure` but has **no** JDK, Gradle, or Android SDK on PATH — it is not the project devShell. Any command that touches gradle or native Android (e.g. `npx expo run:android`, `./android/gradlew …`) must run inside the devShell. From a non-devShell context, wrap it:

```
nix develop --command bash -c 'npx expo run:android'
```

If `JAVA_HOME` is empty or `which java` has no result, you are not in the devShell — the build will fail with `ERROR: JAVA_HOME is not set`.

## Controlling the running emulator from a session

Once an AVD is booted (see above), these are the commands that drive it:

- `adb devices` — expect `emulator-5554 device`.
- `adb shell getprop sys.boot_completed` — `1` once the OS is ready; `adb shell getprop init.svc.bootanim` returns `stopped` when the boot animation finishes.
- App package: `io.github.jonnyczi.copypartyclient` (set explicitly via `app.json`'s `expo.android.package`). This is the permanent published applicationId across GitHub Releases, F-Droid, and Google Play; never reintroduce the old `com.anonymous.*` placeholder.
- After `expo run:android` the dev-client deep-link is fired but the app may not stay foregrounded. Bring it up with `adb shell monkey -p io.github.jonnyczi.copypartyclient -c android.intent.category.LAUNCHER 1`.
- Verify foreground: `adb shell "dumpsys activity activities | grep topResumedActivity"` — look for `io.github.jonnyczi.copypartyclient/.MainActivity`.
- Screenshot: `adb exec-out screencap -p | magick png:- -resize 50% -quality 80 tmp/shot.jpg`, then Read the JPEG. `magick` (ImageMagick) comes from the devShell; the 50%/q80 downscale keeps UI text legible while cutting image tokens ~4× vs the raw 1080×2424 PNG (Claude vision tokens are pixel-count driven, not file-size driven).

## Testing against a copyparty server

`tests/docker-compose.yml` runs `copyparty/ac:latest` on `:3923` with a single account `test:testpw` and a single volume `/w` mounted `A,test` (full access). `--no-mutagen --no-thumb` are set to keep startup fast; the compose healthcheck polls `GET /?reset=/._` until ready. The `copyparty-data` named volume persists between runs — do `docker compose -f tests/docker-compose.yml down -v` (or `npm run test:integration:down`) between runs if a test needs a clean server.

**Automated (Node/vitest) integration tests.** `tests/integration/**/*.test.ts` hit the container over HTTP. `tests/integration/helpers.ts` is the single source of truth for connection details — it exports `COPYPARTY_URL` (default `http://127.0.0.1:3923`), `COPYPARTY_USER` (`test`), `COPYPARTY_PW` (`testpw`), plus `copypartyReachable()`, `withTempDir()`, `writeRandomFile()`, and `uniqueRemoteFolder()`. All three env vars are overridable — point the suite at a non-Docker server by exporting them before `npm run test:integration`. `vitest.integration.config.ts` has a 120s test/hook timeout because cold-start + dedup checks are slow.

**Manual testing from the Android emulator.** The emulator is a VM; its loopback is not your host's. Reach the dockerized copyparty (or any server on the host) at **`http://10.0.2.2:3923`** — `10.0.2.2` is the standard Android-emulator alias for the host's `127.0.0.1`. In-app: add a Server pointing at that URL with user `test` / password `testpw`. Credentials are persisted via `expo-secure-store` under the key `server_<id>_pw` (see `src/storage/secrets.ts`); the base URL and non-secret fields live in the `servers` SQLite table (`src/db/servers.ts`).

**Verifying uploads from the host.** The server is reachable from the host at `127.0.0.1:3923` regardless of who uploaded. Quick sanity check:

```
curl -u test:testpw "http://127.0.0.1:3923/?ls=/"
curl -u test:testpw -O "http://127.0.0.1:3923/<remote-path>/<file>"
```

**`smoke-test-prompt.txt`** at the repo root is a pending design prompt for an end-to-end Android smoke test (Phase 3 manual-verification gap). It is a planning artifact, not a finished spec — confirm decisions with the user before implementing.

## Release pipeline

Full details in `docs/release-pipeline.md`; **deferred work / next steps a fresh
session can pick up are in `docs/roadmap.md`** (cleartext-HTTP fix, F-Droid
submission, Google Play, canonical-mirror sync). Key points for working in this repo:

- **Two toolchains, one source.** `flake.nix` is the toolchain source of truth. Use it for **interactive dev** (`expo run:android`, hot reload). **Release artifacts** (APK/AAB) are built by the **Dagger module** (`.dagger/`, `dagger.json`) which runs `scripts/ci-android-build.sh` inside a `nixos/nix` container via `nix develop` — so a release build needs only a container runtime: `dagger call build-apk export --path ./out/app.apk`. CI (`.github/workflows/`) is a thin `dagger call` wrapper, portable to any CI.
- **Never hand-edit `android/`** (gitignored, regenerated by `expo prebuild`). Native config flows through `app.json` + Expo config plugins. Release signing is injected by `plugins/withReleaseSigning.js` from `COPYPARTY_UPLOAD_*` env vars (debug-signing fallback when absent, which keeps dev + F-Droid builds working).
- **Version** lives only in `app.json` (`expo.version` + `expo.android.versionCode`); bump via `npm run bump-version`. A `vX.Y.Z` tag triggers `release.yml` (asserts tag == app.json version).
- **De-Googled for F-Droid.** Local notifications use `modules/copyparty-notify` (pure-Kotlin, `androidx.core` only) instead of `expo-notifications` (which pulls Firebase). `scripts/scan-nonfree-apk.py` is a CI gate that fails if any `com.google.firebase`/`gms` class reappears — don't reintroduce `expo-notifications`.
- **Known gap:** release builds block cleartext `http://` (Android default), so plain-HTTP copyparty servers fail at runtime with "Network request failed" (works in dev). Not yet fixed — needs a network-security-config decision. See `docs/release-pipeline.md` "Known issues".

## Architecture

Expo Router app (React Native 0.81 + React 19 + Expo SDK 54) targeting iOS, Android, and web from a single codebase.

- **File-based routing** — `app/` defines routes. `app/_layout.tsx` is the root `Stack`; `app/(tabs)/` is a tab group whose own `_layout.tsx` configures the `Tabs` navigator. `app/modal.tsx` is registered in the root Stack as a modal presentation. `unstable_settings.anchor = '(tabs)'` in the root layout sets the default route group. Typed routes are on (`experiments.typedRoutes` in `app.json`).
- **Path alias** — `@/*` resolves to the project root (see `tsconfig.json`). Imports use `@/components/...`, `@/hooks/...`, `@/constants/theme`.
- **Theming** — `useColorScheme()` + `Colors` from `constants/theme.ts` drive light/dark. The root layout wires the scheme into `@react-navigation/native`'s `ThemeProvider`. `ThemedText` / `ThemedView` components and `useThemeColor` consume this.
- **Platform-specific files** — files like `hooks/use-color-scheme.web.ts` and `components/ui/icon-symbol.ios.tsx` are auto-picked by Metro on the matching platform; the non-suffixed file is the fallback. Preserve this pattern when adding platform divergence.
- **New Architecture** — `newArchEnabled: true` and `reactCompiler: true` are set in `app.json`. Reanimated v4 + `react-native-worklets` are installed; `import 'react-native-reanimated'` lives at the top of the root layout.

## Notes

- TypeScript `strict` is on and extends `expo/tsconfig.base`.
- Assets live in `assets/images/` and are referenced from `app.json` (icons, splash, favicon).
- The current `app/` tree is Expo's default starter (Home/Explore tabs, parallax scroll demo, modal). If the user starts building real features, expect the starter screens to be replaced rather than extended.
