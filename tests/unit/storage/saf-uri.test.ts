import { describe, expect, it } from 'vitest';

import { treeUriToDocumentUri } from '@/src/storage/saf-uri';

const EXTERNAL = 'content://com.android.externalstorage.documents';

describe('treeUriToDocumentUri', () => {
  it('appends the document segment for a top-level tree', () => {
    expect(treeUriToDocumentUri(`${EXTERNAL}/tree/primary%3ADCIM`)).toBe(
      `${EXTERNAL}/tree/primary%3ADCIM/document/primary%3ADCIM`,
    );
  });

  it('keeps the document id percent-encoded', () => {
    // The load-bearing one: decoding %2F turns the id into extra path segments
    // and the provider can no longer match it, so the extra is silently ignored
    // and the picker falls back to Recents — the exact bug this fixes.
    expect(treeUriToDocumentUri(`${EXTERNAL}/tree/primary%3ADCIM%2FCamera`)).toBe(
      `${EXTERNAL}/tree/primary%3ADCIM%2FCamera/document/primary%3ADCIM%2FCamera`,
    );
  });

  it('handles a non-primary volume id', () => {
    expect(treeUriToDocumentUri(`${EXTERNAL}/tree/1B0C-4D2E%3ABackups`)).toBe(
      `${EXTERNAL}/tree/1B0C-4D2E%3ABackups/document/1B0C-4D2E%3ABackups`,
    );
  });

  it('passes an already-document URI through unchanged', () => {
    const uri = `${EXTERNAL}/tree/primary%3ADCIM/document/primary%3ADCIM`;
    expect(treeUriToDocumentUri(uri)).toBe(uri);
  });

  it('returns null for anything that is not a tree URI', () => {
    expect(treeUriToDocumentUri('')).toBeNull();
    expect(treeUriToDocumentUri('file:///sdcard/DCIM')).toBeNull();
    expect(treeUriToDocumentUri(`${EXTERNAL}/root/primary`)).toBeNull();
  });

  it('returns null rather than guessing at a tree URI with a query or fragment', () => {
    expect(treeUriToDocumentUri(`${EXTERNAL}/tree/primary%3ADCIM?x=1`)).toBeNull();
  });
});
