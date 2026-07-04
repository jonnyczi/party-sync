/**
 * Below are the colors that are used in the app. The colors are defined in the light and dark mode.
 * There are many other ways to style your app. For example, [Nativewind](https://www.nativewind.dev/), [Tamagui](https://tamagui.dev/), [unistyles](https://reactnativeunistyles.vercel.app), etc.
 */

import { Platform } from 'react-native';

const tintColorLight = '#0a7ea4';
const tintColorDark = '#fff';

export const Colors = {
  light: {
    text: '#11181C',
    background: '#fff',
    tint: tintColorLight,
    icon: '#687076',
    tabIconDefault: '#687076',
    tabIconSelected: tintColorLight,
    // Accent is used as a *fill* behind `onAccent`-colored content. It is
    // deliberately distinct from `tint`: tint is white in dark mode (a
    // foreground colour), so using tint as a background renders white-on-white.
    accent: '#0a7ea4',
    onAccent: '#fff',
    accentWash: '#0a7ea415',
    // Surfaces
    card: '#ffffff',
    border: '#0000001f',
    // Semantic status colours — resolved via statusColor() in
    // constants/status-colors.ts. Tuned for a light background.
    success: '#2a9d3f',
    warning: '#d08900',
    danger: '#c0392b',
    skipped: '#5a7fa6',
    muted: '#6c757d',
    running: '#0a7ea4',
  },
  dark: {
    text: '#ECEDEE',
    background: '#151718',
    tint: tintColorDark,
    icon: '#9BA1A6',
    tabIconDefault: '#9BA1A6',
    tabIconSelected: tintColorDark,
    accent: '#0a7ea4',
    onAccent: '#fff',
    accentWash: '#0a7ea433',
    card: '#1e2022',
    border: '#ffffff26',
    // Brightened so red/green/blue keep contrast against the near-black bg.
    success: '#3fca5c',
    warning: '#e0a72e',
    danger: '#ff6b6b',
    skipped: '#8fb3d9',
    muted: '#9ba1a6',
    running: '#38bdf8',
  },
};

export const Fonts = Platform.select({
  ios: {
    /** iOS `UIFontDescriptorSystemDesignDefault` */
    sans: 'system-ui',
    /** iOS `UIFontDescriptorSystemDesignSerif` */
    serif: 'ui-serif',
    /** iOS `UIFontDescriptorSystemDesignRounded` */
    rounded: 'ui-rounded',
    /** iOS `UIFontDescriptorSystemDesignMonospaced` */
    mono: 'ui-monospace',
  },
  default: {
    sans: 'normal',
    serif: 'serif',
    rounded: 'normal',
    mono: 'monospace',
  },
  web: {
    sans: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    serif: "Georgia, 'Times New Roman', serif",
    rounded: "'SF Pro Rounded', 'Hiragino Maru Gothic ProN', Meiryo, 'MS PGothic', sans-serif",
    mono: "SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
  },
});
