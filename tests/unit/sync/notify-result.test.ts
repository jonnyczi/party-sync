import { describe, expect, it } from 'vitest';

import { formatRunResultNotification } from '@/src/sync/notify-result-format';
import type { RunRow } from '@/src/db/types';

function run(over: Partial<RunRow> = {}): RunRow {
  return {
    id: 7,
    job_id: 1,
    started_at: 1,
    finished_at: 2,
    trigger: 'manual',
    status: 'ok',
    files_scanned: 10,
    files_uploaded: 0,
    files_skipped: 0,
    files_failed: 0,
    bytes_uploaded: 0,
    bytes_deduped: 0,
    skip_reason: null,
    ...over,
  };
}

describe('formatRunResultNotification', () => {
  it('summarizes a successful upload with byte total', () => {
    const { title, body } = formatRunResultNotification(
      run({ status: 'ok', files_uploaded: 142, bytes_uploaded: 1_288_490_188 }),
      'Camera',
    );
    expect(title).toBe('Sync complete · Camera');
    expect(body).toBe('142 uploaded · 1.20 GiB');
  });

  it('appends dedup savings when present', () => {
    const { body } = formatRunResultNotification(
      run({ status: 'ok', files_uploaded: 1, bytes_uploaded: 2048, bytes_deduped: 5120 }),
      'Camera',
    );
    expect(body).toBe('1 uploaded · 2.0 KiB · 5.0 KiB saved');
  });

  it('says nothing changed when nothing uploaded', () => {
    const { body } = formatRunResultNotification(run({ status: 'ok' }), 'Camera');
    expect(body).toBe('Already up to date');
  });

  it('formats a partial run with failure + upload counts', () => {
    const { title, body } = formatRunResultNotification(
      run({ status: 'partial', files_uploaded: 140, files_failed: 3 }),
      'Camera',
    );
    expect(title).toBe('Sync finished with errors · Camera');
    expect(body).toBe('3 failed · 140 uploaded');
  });

  it('formats a failed run', () => {
    const { title, body } = formatRunResultNotification(
      run({ status: 'failed', files_failed: 5 }),
      'Camera',
    );
    expect(title).toBe('Sync failed · Camera');
    expect(body).toBe('5 failed');
  });

  it('handles a run-level failure with no per-file counters', () => {
    const { body } = formatRunResultNotification(
      run({ status: 'failed', files_uploaded: 0, files_failed: 0 }),
      'Camera',
    );
    expect(body).toBe('Run failed — tap for details');
  });
});
