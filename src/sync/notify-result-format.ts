import type { RunRow } from '../db/types';

/**
 * Format the title/body for a finished run's result notification. Pure — no
 * native or react-native imports — so it is unit-testable under vitest (the
 * side-effecting poster lives in `./notify-result`). Callers should only invoke
 * this for terminal statuses (`ok`/`partial`/`failed`).
 */
export function formatRunResultNotification(
  run: RunRow,
  jobName: string,
): { title: string; body: string } {
  if (run.status === 'ok') {
    const parts: string[] = [];
    if (run.files_uploaded > 0) {
      parts.push(`${run.files_uploaded} uploaded`, formatBytes(run.bytes_uploaded));
    } else {
      parts.push('Already up to date');
    }
    if (run.bytes_deduped > 0) parts.push(`${formatBytes(run.bytes_deduped)} saved`);
    return { title: `Sync complete · ${jobName}`, body: parts.join(' · ') };
  }

  const title =
    run.status === 'partial'
      ? `Sync finished with errors · ${jobName}`
      : `Sync failed · ${jobName}`;
  const parts: string[] = [];
  if (run.files_failed > 0) parts.push(`${run.files_failed} failed`);
  if (run.files_uploaded > 0) parts.push(`${run.files_uploaded} uploaded`);
  // Run-level failure (e.g. handshake) can finish with no per-file counters.
  if (parts.length === 0) parts.push('Run failed — tap for details');
  return { title, body: parts.join(' · ') };
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MiB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}
