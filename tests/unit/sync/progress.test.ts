import { describe, expect, it, vi } from 'vitest';

import { ProgressBus } from '@/src/sync/progress';

describe('ProgressBus', () => {
  it('starts with an empty snapshot', () => {
    const bus = new ProgressBus();
    expect(bus.getSnapshot()).toEqual({ activeRun: null });
  });

  it('notifies subscribers on every mutation and produces fresh snapshots', () => {
    const bus = new ProgressBus();
    const listener = vi.fn();
    const unsub = bus.subscribe(listener);

    const s0 = bus.getSnapshot();
    bus.startRun({ runId: 1, jobId: 9, trigger: 'manual', startedAt: 1000 });
    const s1 = bus.getSnapshot();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(s1).not.toBe(s0);
    expect(s1.activeRun).toMatchObject({
      runId: 1,
      jobId: 9,
      trigger: 'manual',
      phase: 'scanning',
      totalFiles: 0,
      totalBytes: 0,
      uploadedBytes: 0,
      wireBytes: 0,
      dedupedBytes: 0,
      activeFiles: [],
    });

    bus.setPhase('uploading');
    expect(bus.getSnapshot().activeRun?.phase).toBe('uploading');
    expect(listener).toHaveBeenCalledTimes(2);

    unsub();
    bus.setPhase('finalizing');
    // Still mutates, just no longer notifies.
    expect(listener).toHaveBeenCalledTimes(2);
    expect(bus.getSnapshot().activeRun?.phase).toBe('finalizing');
  });

  it('records pre-scan totals', () => {
    const bus = new ProgressBus();
    bus.startRun({ runId: 1, jobId: 1, trigger: 'manual', startedAt: 0 });
    bus.setTotals({ totalFiles: 42, totalBytes: 9999 });
    const snap = bus.getSnapshot().activeRun!;
    expect(snap.totalFiles).toBe(42);
    expect(snap.totalBytes).toBe(9999);
  });

  it('tracks in-flight files keyed by localPath and advances uploadedBytes by delta', () => {
    const bus = new ProgressBus();
    bus.startRun({ runId: 2, jobId: 1, trigger: 'manual', startedAt: 0 });

    bus.startFile({ localPath: 'a.bin', name: 'a.bin', size: 1024, bytesUploaded: 0 });
    bus.startFile({ localPath: 'b.bin', name: 'b.bin', size: 2048, bytesUploaded: 0 });
    expect(bus.getSnapshot().activeRun!.activeFiles).toHaveLength(2);

    bus.updateFileBytes('a.bin', 512);
    bus.updateFileBytes('b.bin', 1024);
    let snap = bus.getSnapshot().activeRun!;
    expect(snap.activeFiles.find((f) => f.localPath === 'a.bin')?.bytesUploaded).toBe(512);
    // uploadedBytes is the sum of the per-file deltas (512 + 1024).
    expect(snap.uploadedBytes).toBe(1536);

    // A further update only adds the incremental delta.
    bus.updateFileBytes('a.bin', 1024);
    snap = bus.getSnapshot().activeRun!;
    expect(snap.uploadedBytes).toBe(2048);

    // Ending a file leaves uploadedBytes untouched and removes it from the list.
    bus.endFile('a.bin');
    snap = bus.getSnapshot().activeRun!;
    expect(snap.uploadedBytes).toBe(2048);
    expect(snap.activeFiles.map((f) => f.localPath)).toEqual(['b.bin']);
    // Every one of those bytes really crossed the wire.
    expect(snap.wireBytes).toBe(2048);
  });

  it('startFile replaces any prior entry for the same path', () => {
    const bus = new ProgressBus();
    bus.startRun({ runId: 2, jobId: 1, trigger: 'manual', startedAt: 0 });
    bus.startFile({ localPath: 'a', name: 'a', size: 10, bytesUploaded: 5 });
    bus.startFile({ localPath: 'a', name: 'a', size: 10, bytesUploaded: 0 });
    const files = bus.getSnapshot().activeRun!.activeFiles;
    expect(files).toHaveLength(1);
    expect(files[0].bytesUploaded).toBe(0);
  });

  it('updateFileBytes is a no-op for a file no longer in flight', () => {
    const bus = new ProgressBus();
    bus.startRun({ runId: 2, jobId: 1, trigger: 'manual', startedAt: 0 });
    bus.startFile({ localPath: 'a', name: 'a', size: 10, bytesUploaded: 0 });
    bus.endFile('a');
    bus.updateFileBytes('a', 10); // late progress callback
    expect(bus.getSnapshot().activeRun!.uploadedBytes).toBe(0);
  });

  it('recordDedup advances the bar and the dedup tally but never wireBytes', () => {
    const bus = new ProgressBus();
    bus.startRun({ runId: 2, jobId: 1, trigger: 'manual', startedAt: 0 });
    bus.recordDedup(800);
    const snap = bus.getSnapshot().activeRun!;
    expect(snap.uploadedBytes).toBe(800);
    expect(snap.dedupedBytes).toBe(800);
    // The whole point of the split: deduped bytes never left the phone, so
    // counting them as throughput is what used to report ~GiB/s.
    expect(snap.wireBytes).toBe(0);
  });

  it('tracks file-count counters', () => {
    const bus = new ProgressBus();
    bus.startRun({ runId: 2, jobId: 1, trigger: 'manual', startedAt: 0 });
    bus.bumpCounters({ scanned: 3 });
    bus.bumpCounters({ uploaded: 1, skipped: 1 });
    bus.bumpCounters({ failed: 1 });
    expect(bus.getSnapshot().activeRun!.counters).toEqual({
      scanned: 3,
      uploaded: 1,
      skipped: 1,
      failed: 1,
    });
  });

  it('records errors and clears the run', () => {
    const bus = new ProgressBus();
    bus.startRun({ runId: 3, jobId: 1, trigger: 'manual', startedAt: 0 });
    bus.startFile({ localPath: 'x', name: 'x', size: 1, bytesUploaded: 0 });
    bus.recordError({ localPath: 'x', phase: 'upload', httpStatus: 500, message: 'boom' });

    expect(bus.getSnapshot().activeRun!.errors).toEqual([
      { localPath: 'x', phase: 'upload', httpStatus: 500, message: 'boom' },
    ]);

    bus.endFile('x');
    bus.finishRun();
    expect(bus.getSnapshot().activeRun).toBeNull();
  });

  it('ignores mutations after finishRun until the next startRun', () => {
    const bus = new ProgressBus();
    bus.startRun({ runId: 4, jobId: 1, trigger: 'manual', startedAt: 0 });
    bus.finishRun();

    // Mutating a cleared active run is a no-op, not a crash.
    bus.setPhase('uploading');
    bus.bumpCounters({ uploaded: 1 });
    bus.setTotals({ totalFiles: 1, totalBytes: 1 });
    bus.startFile({ localPath: 'a', name: 'a', size: 1, bytesUploaded: 0 });
    bus.updateFileBytes('a', 1);
    bus.recordDedup(1);
    expect(bus.getSnapshot().activeRun).toBeNull();
  });
});
