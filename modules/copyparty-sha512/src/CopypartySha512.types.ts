/** A `sizes()` entry meaning "no size available" — the caller drops that file. */
export const SIZE_UNAVAILABLE = -1;

/** A `walkTree()` resolution meaning "cancelled via cancelWalk". */
export const WALK_CANCELLED = -1;

/** One file found by {@link CopypartySha512Module.walkTree}. */
export interface SafWalkEntry {
  uri: string;
  /** Slash-joined path from the tree root; never starts with `/`. */
  relativePath: string;
  /** Provider-reported size in bytes. **0**, not -1, when unavailable. */
  size: number;
  /** Provider-reported last-modified in ms. **0**, not -1, when unavailable. */
  mtimeMs: number;
}

/**
 * One batch of walked files. `walkId` is echoed back from the `walkTree` call
 * so a late batch from a previous walk can be discarded.
 */
export interface SafWalkBatchEvent {
  walkId: string;
  entries: SafWalkEntry[];
}

export type CopypartySha512ModuleEvents = {
  onWalkBatch: (event: SafWalkBatchEvent) => void;
};
