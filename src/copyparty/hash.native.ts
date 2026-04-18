import CopypartySha512 from '../../modules/copyparty-sha512';

import type { FileSource } from './hash';

/**
 * RN/Android implementation backed by the `copyparty-sha512` Expo Native
 * Module. Streams via Android ContentResolver so it works for SAF
 * `content://` URIs, file paths, and `file://` URIs uniformly.
 *
 * Tests run in Node and use `nodeFileSource` from `hash.node.ts`; the engine
 * picks one of the two at construction time.
 */
export const nativeFileSource: FileSource = {
  hashFileChunks(uri, chunksize) {
    return CopypartySha512.hashFileChunks(uri, chunksize);
  },
  readRange(uri, car, cdr) {
    return CopypartySha512.readRange(uri, car, cdr);
  },
  size(uri) {
    return CopypartySha512.size(uri);
  },
};
