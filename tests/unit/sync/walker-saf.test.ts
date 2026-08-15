import { describe, expect, it } from 'vitest';

import type {
  SafWalkBatchEvent,
  SafWalkEntry,
} from '@/modules/copyparty-sha512/src/CopypartySha512.types';
import { createSafWalker, type SafWalkNative } from '@/src/sync/walker/saf';
import type { WalkerEntry } from '@/src/sync/walker/types';

/** Let queued microtasks and the generator body run. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function entry(relativePath: string, over: Partial<SafWalkEntry> = {}): SafWalkEntry {
  return {
    uri: `content://tree/doc/${relativePath}`,
    relativePath,
    size: 1,
    mtimeMs: 2,
    ...over,
  };
}

/**
 * Stands in for the native module: lets a test emit batches and settle the
 * walk by hand, and records the cancel/unsubscribe calls the generator's
 * teardown is supposed to make.
 */
function fakeNative() {
  let listener: ((e: SafWalkBatchEvent) => void) | undefined;
  let settle: { resolve(n: number): void; reject(e: unknown): void } | undefined;
  const walkIds: string[] = [];
  const cancelled: string[] = [];
  let removeCount = 0;

  const native: SafWalkNative = {
    walkTree(_treeUri, walkId) {
      walkIds.push(walkId);
      return new Promise<number>((resolve, reject) => {
        settle = { resolve, reject };
      });
    },
    cancelWalk(walkId) {
      cancelled.push(walkId);
    },
    addListener(_event, l) {
      listener = l;
      return {
        remove() {
          removeCount++;
        },
      };
    },
  };

  return {
    native,
    walkIds,
    cancelled,
    get removeCount() {
      return removeCount;
    },
    emit(entries: SafWalkEntry[], walkId?: string) {
      listener?.({ walkId: walkId ?? walkIds[walkIds.length - 1], entries });
    },
    resolve(n = 0) {
      settle?.resolve(n);
    },
    reject(e: unknown) {
      settle?.reject(e);
    },
  };
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of iter) out.push(v);
  return out;
}

describe('safWalker', () => {
  it('maps batch entries to WalkerEntries, in order', async () => {
    const f = fakeNative();
    const walker = createSafWalker(f.native);
    const done = collect(walker.walk('content://tree/root'));

    await tick();
    f.emit([
      entry('a.jpg', { size: 10, mtimeMs: 100 }),
      entry('sub/b.jpg', { size: 20, mtimeMs: 200 }),
    ]);
    f.resolve(2);

    expect(await done).toEqual<WalkerEntry[]>([
      {
        localPath: 'a.jpg',
        uri: 'content://tree/doc/a.jpg',
        relativePath: 'a.jpg',
        size: 10,
        mtimeMs: 100,
      },
      {
        localPath: 'sub/b.jpg',
        uri: 'content://tree/doc/sub/b.jpg',
        relativePath: 'sub/b.jpg',
        size: 20,
        mtimeMs: 200,
      },
    ]);
  });

  it('drains batches that arrived before the consumer pulled', async () => {
    const f = fakeNative();
    const walker = createSafWalker(f.native);
    const it = walker.walk('content://tree/root')[Symbol.asyncIterator]();

    // Start the body so the listener is registered, then queue three batches
    // without pulling — the native side does not wait for us.
    const first = it.next();
    await tick();
    f.emit([entry('1')]);
    f.emit([entry('2')]);
    f.emit([entry('3')]);
    f.resolve(3);

    expect((await first).value).toMatchObject({ relativePath: '1' });
    expect((await it.next()).value).toMatchObject({ relativePath: '2' });
    expect((await it.next()).value).toMatchObject({ relativePath: '3' });
    expect(await it.next()).toEqual({ value: undefined, done: true });
  });

  it('wakes a consumer that is waiting on an empty backlog', async () => {
    const f = fakeNative();
    const walker = createSafWalker(f.native);
    const it = walker.walk('content://tree/root')[Symbol.asyncIterator]();

    const pending = it.next();
    await tick(); // consumer is now parked awaiting a batch
    f.emit([entry('late.jpg')]);

    expect((await pending).value).toMatchObject({ relativePath: 'late.jpg' });
  });

  it('yields buffered batches before surfacing a walk failure', async () => {
    const f = fakeNative();
    const walker = createSafWalker(f.native);
    const it = walker.walk('content://tree/root')[Symbol.asyncIterator]();

    const first = it.next();
    await tick();
    // A walk that dies partway still contributes what it found.
    f.emit([entry('found-before-the-grant-was-revoked.jpg')]);
    f.reject(new Error('tree not accessible or not a directory'));

    expect((await first).value).toMatchObject({
      relativePath: 'found-before-the-grant-was-revoked.jpg',
    });
    await expect(it.next()).rejects.toThrow(/tree not accessible/);
  });

  it('cancels the native walk and unsubscribes when the consumer breaks', async () => {
    const f = fakeNative();
    const walker = createSafWalker(f.native);

    const seen: string[] = [];
    const iter = walker.walk('content://tree/root');
    const pump = (async () => {
      for await (const e of iter) {
        seen.push(e.relativePath);
        break; // the engine's `isCancelRequested` break
      }
    })();

    await tick();
    f.emit([entry('first.jpg'), entry('second.jpg')]);
    await pump;

    expect(seen).toEqual(['first.jpg']);
    // Without this the native side would churn through the rest of the tree
    // for a run that has already been abandoned.
    expect(f.cancelled).toEqual([f.walkIds[0]]);
    expect(f.removeCount).toBe(1);
  });

  it('cancels and unsubscribes on normal completion too', async () => {
    const f = fakeNative();
    const walker = createSafWalker(f.native);
    const done = collect(walker.walk('content://tree/root'));

    await tick();
    f.emit([entry('only.jpg')]);
    f.resolve(1);
    await done;

    // cancelWalk on an already-finished id is a documented no-op.
    expect(f.cancelled).toEqual([f.walkIds[0]]);
    expect(f.removeCount).toBe(1);
  });

  it('ignores batches belonging to a different walk', async () => {
    const f = fakeNative();
    const walker = createSafWalker(f.native);
    const done = collect(walker.walk('content://tree/root'));

    await tick();
    f.emit([entry('stale.jpg')], 'saf-someone-elses-walk');
    f.emit([entry('mine.jpg')]);
    f.resolve(1);

    expect((await done).map((e) => e.relativePath)).toEqual(['mine.jpg']);
  });

  it('completes cleanly when the walk finds nothing', async () => {
    const f = fakeNative();
    const walker = createSafWalker(f.native);
    const done = collect(walker.walk('content://tree/root'));

    await tick();
    f.resolve(0);

    expect(await done).toEqual([]);
  });

  it('yields a batch emitted in the same tick as the resolution', async () => {
    // Pins the ordering guarantee the walker documents: expo-modules-core posts
    // event delivery and promise resolution through the same CallInvoker queue,
    // so a batch can never be dropped by the walk finishing.
    const f = fakeNative();
    const walker = createSafWalker(f.native);
    const done = collect(walker.walk('content://tree/root'));

    await tick();
    f.emit([entry('same-tick.jpg')]);
    f.resolve(1);

    expect((await done).map((e) => e.relativePath)).toEqual(['same-tick.jpg']);
  });

  it('uses a distinct walk id per walk', async () => {
    const f = fakeNative();
    const walker = createSafWalker(f.native);

    const a = collect(walker.walk('content://tree/root'));
    await tick();
    f.resolve(0);
    await a;

    const b = collect(walker.walk('content://tree/root'));
    await tick();
    f.resolve(0);
    await b;

    expect(f.walkIds).toHaveLength(2);
    expect(f.walkIds[0]).not.toBe(f.walkIds[1]);
  });

  it('passes size and mtime through unchanged, including zero', async () => {
    // engine.ts isAlreadySynced compares these exactly. The native walker
    // reports 0 (not -1) when a provider omits SIZE/LAST_MODIFIED, and a
    // walker that "helpfully" normalised that would re-upload the file on
    // every single run.
    const f = fakeNative();
    const walker = createSafWalker(f.native);
    const done = collect(walker.walk('content://tree/root'));

    await tick();
    f.emit([entry('no-metadata.bin', { size: 0, mtimeMs: 0 })]);
    f.resolve(1);

    const out = await done;
    expect(out[0].size).toBe(0);
    expect(out[0].mtimeMs).toBe(0);
  });
});
