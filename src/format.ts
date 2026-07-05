/**
 * Shared display formatters. These were previously duplicated per-screen
 * (dashboard, job detail, run detail) and had started to drift.
 */

/** "512 B" / "3.4 KiB" / "12.8 MiB" / "1.25 GiB" */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MiB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

/** "850ms" / "45s" / "3m 20s" / "12m" */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m}m ${r}s` : `${m}m`;
}

/** Last path segment; returns '' for empty input. */
export function basename(p: string): string {
  if (!p) return '';
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}

/** "just now" / "5m ago" / "2h ago" / "3d ago" — coarse, for glanceable UI. */
export function formatRelativeTime(then: number, now: number = Date.now()): string {
  const min = Math.floor(Math.max(0, now - then) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
