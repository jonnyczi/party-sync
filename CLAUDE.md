# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm start` / `npx expo start` — start the Expo dev server (Metro bundler); opens a menu to launch iOS simulator, Android emulator, web, or Expo Go.
- `npm run android` / `npm run ios` — `expo run:<platform>`: prebuild + native compile + install dev build on emulator/simulator + start Metro. The project uses native modules (`modules/copyparty-sha512`), so Expo Go is not an option. Android requires the dev shell: see "Native Android dev environment" below.
- `npm run web` — `expo start --web`.
- `npm run lint` — runs `expo lint` (ESLint via `eslint-config-expo/flat`).
- `npm run reset-project` — **destructive**: moves or deletes `app/`, `components/`, `hooks/`, `constants/`, `scripts/` (optionally into `app-example/`) and scaffolds a blank `app/`. Only run when the user explicitly asks to reset the template.

No test runner is configured.

## Native Android dev environment (NixOS)

The project includes `flake.nix` providing a reproducible Android build toolchain. The Android emulator + AVDs stay on the host (managed via Android Studio); the flake only covers what's needed to compile a dev build.

**Quick start** (from the repo root):

```
nix develop
npx expo run:android        # or `npm run android` from inside the shell
```

**What the dev shell provides**: JDK 17, Gradle 8.14.x, Android SDK platforms 35 + 36, build-tools 35.0.0 + 36.0.0, NDK 27.1.12297006, CMake 3.22.1. Platform 35 is required because `modules/copyparty-sha512`'s `expo-module-gradle-plugin` defaults `compileSdkVersion` to 35 when no version catalog overrides it; everything else uses 36.

**What stays on the host**: the Android emulator and AVDs. Run `emulator @<AVD>` from any shell and `adb devices` to confirm. The flake intentionally omits `includeEmulator`/`includeSystemImages` to keep its closure small.

**Host prerequisite (this machine only)**: a symlink so the macOS-style PATH entries resolve to the Linux SDK location:

```
mkdir -p ~/Library/Android && ln -sfn ~/Android/Sdk ~/Library/Android/sdk
```

Other contributors with a standard Linux SDK path don't need this.

**Gradle wrapper hardening**: the `shellHook` in `flake.nix` automatically (a) bumps the wrapper's `networkTimeout` from the prebuild default (10s) to 600s and (b) primes `~/.gradle/wrapper/dists/...` with the Gradle distribution zip + `.ok` marker on first shell entry. If priming fails (network), the shell prints the exact `curl` command to retry.

**`flake.lock` is committed** — pins `nixpkgs` (currently `nixos-25.11`) so all clones get identical store paths.

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
