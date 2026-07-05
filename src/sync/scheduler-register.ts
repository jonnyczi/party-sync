import * as TaskManager from 'expo-task-manager';

import CopypartySync from '../../modules/copyparty-sync';
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
    // Liveness handshake with the native worker: signals that the headless JS
    // world actually came up (see TickLiveness.kt) before doing anything that
    // could take time. Fire-and-forget by design.
    CopypartySync?.markTickAlive().catch(() => {});
    try {
      const db = await openDb();
      await runPeriodicTick(db);
    } catch (e) {
      console.warn('[copyparty] periodic task failed', e);
    }
  });
}

/**
 * Inspect current jobs and enable/disable the WorkManager task accordingly.
 * Called on app launch and after any job create/update/delete. Idempotent —
 * re-registering an already-registered task is a no-op (the native side uses
 * ExistingPeriodicWorkPolicy.UPDATE).
 *
 * Scheduling goes through modules/copyparty-sync rather than
 * expo-background-task: its worker promotes itself to a dataSync foreground
 * service before the JS loads, without which Android's cached-app freezer
 * froze the headless process before the task body could run.
 */
export async function syncPeriodicRegistration(db: SqliteDb): Promise<void> {
  if (!CopypartySync) return; // Android-only; iOS/web have no periodic sync
  const jobs = await listJobs(db);
  const anyEnabled = jobs.some((j) => j.periodic_enabled === 1);
  const isRegistered = await TaskManager.isTaskRegisteredAsync(
    PERIODIC_TASK_NAME,
  );

  if (anyEnabled && !isRegistered) {
    await CopypartySync.registerPeriodicTask(
      PERIODIC_TASK_NAME,
      PERIODIC_MIN_INTERVAL_MIN,
    );
  } else if (!anyEnabled && isRegistered) {
    await CopypartySync.unregisterPeriodicTask(PERIODIC_TASK_NAME);
  }
}
