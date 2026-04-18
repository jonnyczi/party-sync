# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm start` / `npx expo start` — start the Expo dev server (Metro bundler); opens a menu to launch iOS simulator, Android emulator, web, or Expo Go.
- `npm run ios` / `npm run android` / `npm run web` — start and target a specific platform directly.
- `npm run lint` — runs `expo lint` (ESLint via `eslint-config-expo/flat`).
- `npm run reset-project` — **destructive**: moves or deletes `app/`, `components/`, `hooks/`, `constants/`, `scripts/` (optionally into `app-example/`) and scaffolds a blank `app/`. Only run when the user explicitly asks to reset the template.

No test runner is configured.

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
