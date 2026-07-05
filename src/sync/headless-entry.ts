import * as SQLite from 'expo-sqlite';

import { DB_NAME } from '../db/name';
import { configureConnection } from '../db/schema';

import { definePeriodicTask } from './scheduler-register';

/**
 * Module-scope side effect, imported FIRST from the bundle entry (index.ts).
 *
 * The periodic background task must be defined during bundle evaluation with
 * no React surface: route modules like app/_layout.tsx only execute when the
 * router *renders*, and a headless WorkManager cold start evaluates the
 * bundle without ever mounting a surface. When this setup lived in _layout,
 * headless ticks dispatched an event no listener would ever pick up — the
 * worker waited forever and scheduled sync silently did nothing after the
 * app was swiped away.
 *
 * Importing this module also pulls in (via the task body's import chain) the
 * keep-alive headless-task registration and expo-task-manager's JS listener,
 * both of which must exist before the queued task event is flushed.
 */

// Each invocation opens its own DB handle: in a headless process there is no
// SQLiteProvider, and even in-app the provider may not be mounted yet.
definePeriodicTask(async () => {
  const db = await SQLite.openDatabaseAsync(DB_NAME);
  await configureConnection(db);
  return db;
});
