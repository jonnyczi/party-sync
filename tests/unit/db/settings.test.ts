import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runMigrations } from '@/src/db/schema';
import {
  getBoolSetting,
  getResultNotificationsEnabled,
  setBoolSetting,
  setResultNotificationsEnabled,
} from '@/src/db/settings';

import { createTestDb } from './adapter';

let db: ReturnType<typeof createTestDb>;

beforeEach(async () => {
  db = createTestDb();
  await runMigrations(db);
});
afterEach(() => {
  db.close();
});

describe('settings DAO', () => {
  it('returns the fallback when a key is unset', async () => {
    expect(await getBoolSetting(db, 'missing', true)).toBe(true);
    expect(await getBoolSetting(db, 'missing', false)).toBe(false);
  });

  it('round-trips a boolean and upserts on repeat writes', async () => {
    await setBoolSetting(db, 'k', true);
    expect(await getBoolSetting(db, 'k', false)).toBe(true);
    await setBoolSetting(db, 'k', false);
    expect(await getBoolSetting(db, 'k', true)).toBe(false);
  });

  it('result notifications default to on, then persist toggles', async () => {
    expect(await getResultNotificationsEnabled(db)).toBe(true);
    await setResultNotificationsEnabled(db, false);
    expect(await getResultNotificationsEnabled(db)).toBe(false);
    await setResultNotificationsEnabled(db, true);
    expect(await getResultNotificationsEnabled(db)).toBe(true);
  });
});
