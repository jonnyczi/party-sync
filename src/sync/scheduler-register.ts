import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';

import type { SqliteDb } from '../db/adapter';
import { listJobs } from '../db/jobs';

import {
  PERIODIC_MIN_INTERVAL_MIN,
  PERIODIC_TASK_NAME,
} from './scheduler';
import { runPeriodicTick } from './triggers/periodic';

let taskDefined = false;

/**
 * Register the background task with TaskManager. Must be called at module
 * load time (not inside a React component) — TaskManager requires tasks to
 * be known before any background invocation. The task body opens its own
 * DB handle; background invocations can fire with no React tree mounted.
 */
export function definePeriodicTask(openDb: () => Promise<SqliteDb>): void {
  if (taskDefined) return;
  taskDefined = true;

  TaskManager.defineTask(PERIODIC_TASK_NAME, async () => {
    try {
      const db = await openDb();
      await runPeriodicTick(db);
      return BackgroundTask.BackgroundTaskResult.Success;
    } catch (e) {
      console.warn('[copyparty] periodic task failed', e);
      return BackgroundTask.BackgroundTaskResult.Failed;
    }
  });
}

/**
 * Inspect current jobs and enable/disable the WorkManager task accordingly.
 * Called on app launch and after any job create/update/delete. Idempotent —
 * re-registering an already-registered task is a no-op.
 */
export async function syncPeriodicRegistration(db: SqliteDb): Promise<void> {
  const jobs = await listJobs(db);
  const anyEnabled = jobs.some((j) => j.periodic_enabled === 1);
  const isRegistered = await TaskManager.isTaskRegisteredAsync(
    PERIODIC_TASK_NAME,
  );

  if (anyEnabled && !isRegistered) {
    await BackgroundTask.registerTaskAsync(PERIODIC_TASK_NAME, {
      minimumInterval: PERIODIC_MIN_INTERVAL_MIN,
    });
  } else if (!anyEnabled && isRegistered) {
    await BackgroundTask.unregisterTaskAsync(PERIODIC_TASK_NAME);
  }
}
