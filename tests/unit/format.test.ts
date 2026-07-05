import { describe, expect, it } from 'vitest';

import {
  basename,
  formatBytes,
  formatDuration,
  formatRelativeTime,
} from '@/src/format';

describe('formatBytes', () => {
  it('formats each magnitude with its unit', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1.0 KiB');
    expect(formatBytes(1536)).toBe('1.5 KiB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MiB');
    expect(formatBytes(2.25 * 1024 * 1024 * 1024)).toBe('2.25 GiB');
  });
});

describe('formatDuration', () => {
  it('picks ms, seconds, or minutes as appropriate', () => {
    expect(formatDuration(850)).toBe('850ms');
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(200_000)).toBe('3m 20s');
    expect(formatDuration(720_000)).toBe('12m');
  });
});

describe('formatRelativeTime', () => {
  it('buckets into minutes, hours, and days', () => {
    const now = 1_000_000_000_000;
    expect(formatRelativeTime(now - 30_000, now)).toBe('just now');
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe('5m ago');
    expect(formatRelativeTime(now - 2 * 3_600_000, now)).toBe('2h ago');
    expect(formatRelativeTime(now - 3 * 86_400_000, now)).toBe('3d ago');
    expect(formatRelativeTime(now + 60_000, now)).toBe('just now');
  });
});

describe('basename', () => {
  it('returns the last path segment', () => {
    expect(basename('/a/b/c.jpg')).toBe('c.jpg');
    expect(basename('c.jpg')).toBe('c.jpg');
    expect(basename('')).toBe('');
    expect(basename('/trailing/')).toBe('');
  });
});
