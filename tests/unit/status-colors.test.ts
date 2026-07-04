import { describe, expect, it, vi } from 'vitest';

// theme.ts imports `Platform` from react-native at module load; stub it so this
// pure-logic test runs under the node vitest environment.
vi.mock('react-native', () => ({
  Platform: { select: (o: Record<string, unknown>) => o.default },
}));

import { statusColor } from '@/constants/status-colors';
import { Colors } from '@/constants/theme';

describe('statusColor', () => {
  it('maps every run status to its semantic token, per scheme', () => {
    expect(statusColor('ok', 'light')).toBe(Colors.light.success);
    expect(statusColor('ok', 'dark')).toBe(Colors.dark.success);
    expect(statusColor('partial', 'light')).toBe(Colors.light.warning);
    expect(statusColor('failed', 'dark')).toBe(Colors.dark.danger);
    expect(statusColor('skipped', 'light')).toBe(Colors.light.skipped);
    expect(statusColor('running', 'dark')).toBe(Colors.dark.running);
    expect(statusColor('cancelled', 'light')).toBe(Colors.light.muted);
    expect(statusColor('interrupted', 'dark')).toBe(Colors.dark.muted);
  });

  it('guards against the dark-mode invisible-button bug', () => {
    // `tint` is white in dark mode (a foreground colour). Any *fill* must use
    // `accent`, which must therefore never be white, and `onAccent` sits on it.
    expect(Colors.dark.tint).toBe('#fff');
    expect(Colors.dark.accent).not.toBe('#fff');
    expect(Colors.dark.onAccent).toBe('#fff');
    expect(Colors.light.accent).not.toBe(Colors.light.background);
  });
});
