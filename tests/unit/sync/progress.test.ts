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

  it('tracks active file bytes and counters', () => {
    const bus = new ProgressBus();
    bus.startRun({ runId: 2, jobId: 1, trigger: 'manual', startedAt: 0 });

    bus.setActiveFile({ localPath: 'a.bin', name: 'a.bin', size: 1024, bytesUploaded: 0 });
    bus.updateActiveFileBytes(512);
    bus.bumpCounters({ scanned: 1, bytesUploaded: 512 });

    const snap = bus.getSnapshot().activeRun!;
    expect(snap.activeFile?.bytesUploaded).toBe(512);
    expect(snap.counters).toEqual({
      scanned: 1,
      uploaded: 0,
      skipped: 0,
      failed: 0,
      bytesUploaded: 512,
    });

    bus.bumpCounters({ uploaded: 1, bytesUploaded: 512 });
    expect(bus.getSnapshot().activeRun!.counters.uploaded).toBe(1);
    expect(bus.getSnapshot().activeRun!.counters.bytesUploaded).toBe(1024);
  });

  it('records errors and clears active file + run', () => {
    const bus = new ProgressBus();
    bus.startRun({ runId: 3, jobId: 1, trigger: 'manual', startedAt: 0 });
    bus.setActiveFile({ localPath: 'x', name: 'x', size: 1, bytesUploaded: 0 });
    bus.recordError({ localPath: 'x', phase: 'upload', httpStatus: 500, message: 'boom' });

    expect(bus.getSnapshot().activeRun!.errors).toEqual([
      { localPath: 'x', phase: 'upload', httpStatus: 500, message: 'boom' },
    ]);

    bus.setActiveFile(null);
    bus.finishRun();
    expect(bus.getSnapshot().activeRun).toBeNull();
  });

  it('ignores mutations after finishRun until the next startRun', () => {
    const bus = new ProgressBus();
    bus.startRun({ runId: 4, jobId: 1, trigger: 'manual', startedAt: 0 });
    bus.finishRun();

    // setPhase on a cleared active run is a no-op, not a crash.
    bus.setPhase('uploading');
    bus.bumpCounters({ uploaded: 1 });
    bus.updateActiveFileBytes(99);
    expect(bus.getSnapshot().activeRun).toBeNull();
  });
});
