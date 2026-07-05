package expo.modules.copypartysync

import android.content.Context
import android.util.Log
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import expo.modules.interfaces.taskManager.TaskServiceProviderHelper
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.awaitAll
import java.util.concurrent.TimeUnit

/**
 * WorkManager scheduling for the periodic sync tick.
 *
 * Uses a real PeriodicWorkRequest rather than expo-background-task's
 * self-chaining OneTimeWorkRequest: that chain only enqueues the next tick
 * after the current one completes, so one process death mid-run kills
 * periodic sync permanently. Periodic work is rescheduled by WorkManager
 * itself and survives crashes and reboots.
 */
object SyncScheduler {
  private const val TAG = "CopypartySync"
  private const val UNIQUE_WORK = "copyparty-periodic-work"

  /** expo-background-task's unique-work name; cancel leftovers on upgrade. */
  private const val LEGACY_EXPO_WORK = "EXPO_BACKGROUND_WORKER"

  fun schedule(context: Context, intervalMinutes: Long) {
    val wm = WorkManager.getInstance(context.applicationContext)
    wm.cancelUniqueWork(LEGACY_EXPO_WORK)
    val minutes = intervalMinutes.coerceAtLeast(15L) // WorkManager's periodic floor
    val request = PeriodicWorkRequestBuilder<SyncTaskWorker>(minutes, TimeUnit.MINUTES)
      .setConstraints(
        Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build(),
      )
      .build()
    // UPDATE keeps the existing schedule's timing when nothing changed, so
    // re-registration on every app launch is idempotent.
    wm.enqueueUniquePeriodicWork(UNIQUE_WORK, ExistingPeriodicWorkPolicy.UPDATE, request)
    Log.d(TAG, "periodic work scheduled every $minutes min")
  }

  fun cancel(context: Context) {
    WorkManager.getInstance(context.applicationContext).cancelUniqueWork(UNIQUE_WORK)
    Log.d(TAG, "periodic work cancelled")
  }

  /**
   * Execute every registered copyparty task and wait for the JS bodies to
   * settle. TaskServiceProviderHelper bootstraps expo-task-manager's
   * TaskService (restoring persisted tasks) even in a cold headless process.
   */
  suspend fun runRegisteredTasks(context: Context) {
    val taskService = TaskServiceProviderHelper.getTaskServiceImpl(context.applicationContext)
    if (taskService == null) {
      Log.e(TAG, "task service unavailable; skipping tick")
      return
    }
    val consumers = taskService
      .getTaskConsumers(context.packageName)
      .filterIsInstance<SyncTaskConsumer>()
    Log.d(TAG, "tick: ${consumers.size} registered sync task(s)")
    consumers
      .map { consumer ->
        val done = CompletableDeferred<Unit>()
        try {
          consumer.executeTask { done.complete(Unit) }
        } catch (t: Throwable) {
          Log.e(TAG, "task execution failed", t)
          done.complete(Unit)
        }
        done
      }
      .awaitAll()
  }
}
