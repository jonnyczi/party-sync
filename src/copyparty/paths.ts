/**
 * Remote-path string helpers shared by the job editor and the server browser.
 * These operate on copyparty folder paths (leading slash, no trailing slash),
 * not on full URLs — URL construction lives in {@link CopypartyClient.folderUrl}.
 */

/**
 * Normalize a user-entered remote path: trim, ensure a leading slash, and strip
 * trailing slashes. Empty input maps to '' so callers can treat it as "unset";
 * a lone '/' is preserved as the root.
 */
export function normalizeRemotePath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  const withSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withSlash.replace(/\/+$/, '') || '/';
}

/**
 * Append a single folder name to a parent path.
 * `childPath('/a', 'b')` → `'/a/b'`; `childPath('/', 'b')` → `'/b'`.
 */
export function childPath(parent: string, name: string): string {
  const base = parent.replace(/\/+$/, '');
  return `${base}/${name}`;
}

/**
 * The parent of a path, clamped at the root.
 * `'/a/b'` → `'/a'`, `'/a'` → `'/'`, `'/'` → `'/'`.
 */
export function parentPath(path: string): string {
  const norm = path.replace(/\/+$/, '');
  const idx = norm.lastIndexOf('/');
  if (idx <= 0) return '/';
  return norm.slice(0, idx);
}
