package expo.modules.copypartysync

import android.content.Context
import android.os.CancellationSignal
import android.util.Log
import androidx.core.app.NotificationManagerCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactContext
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.facebook.react.jstasks.HeadlessJsTaskContext
import expo.modules.interfaces.taskManager.TaskManagerInterface
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Android background-sync support: a real dataSync foreground service (+
 * partial wake lock) wrapped around sync runs. Pure androidx — no Google Play
 * Services / Firebase (F-Droid clean, same rule as modules/copyparty-notify).
 *
 * Android-only: the JS side uses `requireOptionalNativeModule`, so on iOS/web
 * the native object is null and callers no-op.
 */
class CopypartySyncModule : Module() {
  companion object {
    private const val TAG = "CopypartySync"

    /** Must match the AppRegistry.registerHeadlessTask key in src/sync/keep-alive.ts. */
    private const val KEEPALIVE_TASK = "copyparty-keepalive"
  }

  override fun definition() = ModuleDefinition {
    Name("CopypartySync")

    /**
     * Returns true when the foreground service is up; false when Android
     * refused the start (background-started process without an exemption on
     * API 31+). Callers fall back to the plain-notification path on false.
     */
    AsyncFunction("startForegroundSync") { title: String, text: String ->
      try {
        SyncForegroundService.start(context, title, text)
        true
      } catch (t: Throwable) {
        Log.w(TAG, "foreground service start refused", t)
        false
      }
    }

    /**
     * Refresh the running service's notification text (live speed / ETA)
     * without restarting the service. Re-posting the same notification id is
     * the sanctioned way to update a foreground-service notification: the
     * FOREGROUND_SERVICE_TYPE_DATA_SYNC binding lives on the *service*, not on
     * the notification, so it survives untouched.
     *
     * No-op-safe: if the service isn't running this posts a stray ongoing
     * notification, so JS only calls it while it believes the service is up,
     * and the run's teardown clears the same id either way.
     */
    AsyncFunction("updateForegroundSync") { title: String, text: String ->
      try {
        SyncNotifications.ensureChannel(context)
        NotificationManagerCompat.from(context).notify(
          SyncForegroundService.NOTIF_ID,
          SyncNotifications.ongoing(context, title, text),
        )
      } catch (t: Throwable) {
        // A notification must never fail a sync (POST_NOTIFICATIONS denied,
        // rate limiting, …). Log and carry on.
        Log.w(TAG, "foreground notification update failed", t)
      }
    }

    AsyncFunction("stopForegroundSync") {
      SyncForegroundService.stop(context)
    }

    /**
     * Register a no-op headless JS task with React Native for the duration of
     * a sync run. This is the piece a foreground service alone can't provide:
     * when the last Activity is destroyed (swipe-away) RN suspends the JS
     * world — verified: an in-flight upload froze at the swipe and resumed
     * only on relaunch, with the FGS + wake lock held throughout. An active
     * headless task is RN's sanctioned "app has background JS work" signal
     * (same mechanism react-native-background-actions uses); it keeps timers
     * and task dispatch running with no Activity.
     *
     * The JS side registers `copyparty-keepalive` via AppRegistry whose task
     * promise resolves when the run ends — RN then notifies native completion
     * itself, so there is no finishTask counterpart here.
     */
    AsyncFunction("startKeepAlive") { promise: Promise ->
      val reactContext = appContext.reactContext as? ReactContext
      if (reactContext == null) {
        promise.reject(SyncModuleException("react context unavailable"))
        return@AsyncFunction
      }
      // startTask asserts the UI thread.
      UiThreadUtil.runOnUiThread {
        try {
          val headlessContext = HeadlessJsTaskContext.getInstance(reactContext)
          val taskId = headlessContext.startTask(
            HeadlessJsTaskConfig(
              KEEPALIVE_TASK,
              Arguments.createMap(),
              0, // no timeout — the run's finally resolves the JS promise
              true, // allowed while foregrounded (runs start in the foreground)
            ),
          )
          promise.resolve(taskId)
        } catch (t: Throwable) {
          promise.reject(SyncModuleException("keep-alive start failed: ${t.message}"))
        }
      }
    }

    /**
     * Register the periodic tick with expo-task-manager, using our
     * SyncTaskConsumer (which schedules the freezer-safe WorkManager worker).
     * The JS task body itself stays with TaskManager.defineTask.
     */
    AsyncFunction("registerPeriodicTask") { taskName: String, intervalMinutes: Int ->
      taskManager.registerTask(
        taskName,
        SyncTaskConsumer::class.java,
        mapOf("intervalMinutes" to intervalMinutes),
      )
    }

    AsyncFunction("unregisterPeriodicTask") { taskName: String ->
      taskManager.unregisterTask(taskName, SyncTaskConsumer::class.java)
    }

    /** First statement of the JS periodic task body — see TickLiveness. */
    AsyncFunction("markTickAlive") {
      TickLiveness.alive = true
    }

    // ---- Device probes (see src/sync/health.ts, src/permissions/permissions.ts) ----

    Function("isIgnoringBatteryOptimizations") {
      DeviceProbes.isIgnoringBatteryOptimizations(context)
    }

    Function("isBackgroundRestricted") {
      DeviceProbes.isBackgroundRestricted(context)
    }

    Function("areNotificationsEnabled") {
      DeviceProbes.areNotificationsEnabled(context)
    }

    /** Screen on? Polled by the bandwidth limiter (src/sync/throttle.ts). */
    Function("isScreenInteractive") {
      DeviceProbes.isScreenInteractive(context)
    }

    Function("getDataSaverStatus") {
      DeviceProbes.getDataSaverStatus(context)
    }

    Function("getAppStandbyBucket") {
      DeviceProbes.getAppStandbyBucket(context)
    }

    Function("getManufacturer") {
      DeviceProbes.getManufacturer()
    }

    // ---- Storage probes (see src/storage/saf.ts) ----

    /**
     * Whether a persisted SAF tree grant is still usable, in one row query
     * instead of enumerating the folder. Resolves null when the storage
     * provider did not answer in time — see the TS declaration for why null is
     * not false.
     */
    AsyncFunction("canReadFolder") Coroutine { treeUri: String, timeoutMs: Int ->
      val ctx = context
      val signal = CancellationSignal()
      withTimeoutOrNull(timeoutMs.toLong()) {
        withContext(Dispatchers.IO) { SafProbes.canReadFolder(ctx, treeUri, signal) }
      } ?: run {
        // Cancellation is cooperative only: ExternalStorageProvider does
        // filesystem work and never polls the signal, so a wedged volume keeps
        // one Dispatchers.IO thread blocked until the kernel returns. That is
        // exactly why the blocking call is on Dispatchers.IO and not run
        // directly on the modules queue — withTimeoutOrNull suspends this
        // coroutine and frees the queue, and the IO pool is elastic, so a
        // stranded thread cannot stall the module's other calls. Not a leak; do
        // not "fix" it by dropping the timeout.
        signal.cancel()
        null
      }
    }

    // ---- Settings shortcuts (the checklist's Fix buttons) ----

    AsyncFunction("requestIgnoreBatteryOptimizations") {
      SettingsIntents.requestIgnoreBatteryOptimizations(intentContext)
    }

    AsyncFunction("openNotificationSettings") {
      SettingsIntents.openNotificationSettings(intentContext)
    }

    AsyncFunction("openDataSaverSettings") {
      SettingsIntents.openDataSaverSettings(intentContext)
    }

    AsyncFunction("openAppSettings") {
      SettingsIntents.openAppSettings(intentContext)
    }

    // Feeds AppForegroundTracker, which the periodic worker consults: a
    // headless process never runs these hooks, so the flag is false exactly
    // when freezer protection is needed.
    OnActivityEntersForeground { AppForegroundTracker.inForeground = true }
    OnActivityEntersBackground { AppForegroundTracker.inForeground = false }
  }

  /** Prefer the current activity so settings screens stack onto the app's
   *  task; the application context works too (NEW_TASK is always set). */
  private val intentContext: Context
    get() = appContext.currentActivity ?: context

  private val taskManager: TaskManagerInterface
    get() = appContext.legacyModule<TaskManagerInterface>()
      ?: throw SyncModuleException("expo-task-manager unavailable")

  private val context: Context
    get() = appContext.reactContext
      ?: throw SyncModuleException("react context unavailable")
}

private class SyncModuleException(message: String) : CodedException(message)
