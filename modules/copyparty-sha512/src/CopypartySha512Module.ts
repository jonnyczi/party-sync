import { NativeModule, requireNativeModule } from 'expo';

import { CopypartySha512ModuleEvents } from './CopypartySha512.types';

declare class CopypartySha512Module extends NativeModule<CopypartySha512ModuleEvents> {
  /**
   * Stream the file at `uri` (content://, file://, or absolute path) and
   * return one base64url chunk hash per chunk, in order. Each hash is the
   * first 33 bytes of SHA-512(chunk) base64url-encoded with no padding,
   * matching copyparty's wire format (44 chars per hash).
   */
  hashFileChunks(uri: string, chunksize: number): Promise<string[]>;

  /** Read bytes in [car, cdr) from `uri`. Returns the chunk for an upload POST. */
  readRange(uri: string, car: number, cdr: number): Promise<Uint8Array>;

  /** Resolve the size in bytes of `uri`. */
  size(uri: string): Promise<number>;
}

export default requireNativeModule<CopypartySha512Module>('CopypartySha512');
