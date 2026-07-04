import type { PathOrganization } from '../db/types';

export type { PathOrganization };

/** All modes, in display order (flat first). */
export const PATH_ORGANIZATIONS: PathOrganization[] = [
  'flat',
  'year',
  'year_month',
  'year_month_day',
];

/**
 * Date subfolder (no leading/trailing slash) for a file, given its modification
 * time and the job's organization mode. Returns '' for 'flat'. Uses device-local
 * time so the bucket matches the day the user perceives; month/day are
 * zero-padded so listings sort chronologically.
 */
export function dateSubdir(mtimeMs: number, mode: PathOrganization): string {
  if (mode === 'flat') return '';
  const d = new Date(mtimeMs);
  const y = String(d.getFullYear());
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  if (mode === 'year') return y;
  if (mode === 'year_month') return `${y}/${m}`;
  return `${y}/${m}/${day}`; // year_month_day
}
