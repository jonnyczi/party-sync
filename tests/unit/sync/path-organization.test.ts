import { describe, expect, it } from 'vitest';

import { dateSubdir, PATH_ORGANIZATIONS } from '@/src/sync/path-organization';

// 2026-06-05 09:30 local — single-digit month AND day to exercise padding.
const SINGLE_DIGIT = new Date(2026, 5, 5, 9, 30).getTime();
// 2026-12-20 local — two-digit month/day, no padding needed.
const TWO_DIGIT = new Date(2026, 11, 20).getTime();

describe('dateSubdir', () => {
  it('returns empty string for flat', () => {
    expect(dateSubdir(SINGLE_DIGIT, 'flat')).toBe('');
  });

  it('returns the year for year mode', () => {
    expect(dateSubdir(SINGLE_DIGIT, 'year')).toBe('2026');
  });

  it('zero-pads single-digit month for year_month', () => {
    expect(dateSubdir(SINGLE_DIGIT, 'year_month')).toBe('2026/06');
  });

  it('zero-pads single-digit month and day for year_month_day', () => {
    expect(dateSubdir(SINGLE_DIGIT, 'year_month_day')).toBe('2026/06/05');
  });

  it('leaves two-digit month and day unpadded', () => {
    expect(dateSubdir(TWO_DIGIT, 'year_month')).toBe('2026/12');
    expect(dateSubdir(TWO_DIGIT, 'year_month_day')).toBe('2026/12/20');
  });

  it('lists flat first', () => {
    expect(PATH_ORGANIZATIONS[0]).toBe('flat');
    expect(PATH_ORGANIZATIONS).toEqual([
      'flat',
      'year',
      'year_month',
      'year_month_day',
    ]);
  });
});
