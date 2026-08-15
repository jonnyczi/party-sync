/**
 * The document form of a SAF tree URI.
 *
 * `ACTION_OPEN_DOCUMENT_TREE`'s `EXTRA_INITIAL_URI` wants a *document* URI, not
 * a tree URI, and DocumentsUI silently ignores anything it cannot resolve —
 * which is why re-picking a folder lands in Recents instead of where the user
 * already was:
 *
 *     content://…/tree/primary%3ADCIM
 *   → content://…/tree/primary%3ADCIM/document/primary%3ADCIM
 *
 * The document id must keep its percent-encoding exactly as stored; decoding it
 * produces a URI the provider cannot match. Returns null for anything that is
 * not a bare tree URI, which the caller passes straight through — a wrong guess
 * costs nothing but an ignored extra.
 */
const TREE_URI = /^content:\/\/[^/]+\/tree\/([^/?#]+)$/;

export function treeUriToDocumentUri(uri: string): string | null {
  if (!uri) return null;
  // Already a document URI (some providers hand one back) — use it as-is.
  if (uri.includes('/document/')) return uri;
  const m = TREE_URI.exec(uri);
  return m ? `${uri}/document/${m[1]}` : null;
}
