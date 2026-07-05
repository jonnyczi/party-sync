package expo.modules.copypartysync

import android.content.Context
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.Process
import android.util.Log
import androidx.work.CoroutineWorker
import androidx.work.ForegroundInfo
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeoutOrNull

/**
 * The periodic-tick worker. Two hard-won behaviors:
 *
 * 1. `setForeground()` is called BEFORE any JS loads. On a headless cold start
 *    the cached-app freezer froze the spawned process ~10s after spawn —
 *    before the JS bundle executed — so ticks silently no-oped. The dataSync
 *    promotion keeps the process unfreezable while the headless React context
 *    loads and the sync runs. It throws on Android 12+ when the app is
 *    background-started without the battery-optimization exemption (which the
 *    in-app health checklist asks for); we then proceed best-effort under a
 *    short cap — no worse than the old behavior.
 *
 * 2. A liveness watchdog (see TickLiveness): the headless JS occasionally
 *    never comes up (bundle evaluation parks forever — observed on release,
 *    nondeterministic). If JS hasn't signalled within JS_LIVENESS_MS the
 *    worker returns retry() and exits the headless process so the retry runs
 *    in a fresh spawn, which is what every successful attempt looks like.
 */
class SyncTaskWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
  companion object {
    private const val TAG = "CopypartySync"

    // Ample room for a large first sync under the FGS; well inside Android
    // 15's 6h dataSync budget.
    private const val FOREGROUND_CAP_MS = 2L * 60 * 60 * 1000

    // Without an FGS, JobScheduler-backed work gets ~10 minutes; exit cleanly
    // before the system does it for us.
    private const val BACKGROUND_CAP_MS = 9L * 60 * 1000

    // Healthy headless JS loads signal in ~1s; give slow devices a wide berth.
    private const val JS_LIVENESS_MS = 60L * 1000
  }

  override suspend fun doWork(): Result {
    // Skip the promotion when an activity is resumed: the app is alive (no
    // freezer risk) and a "scheduled sync" notification would be noise. Unlike
    // expo-background-task we still run the tick — the JS side already bails
    // when a run is active.
    val foregrounded = if (AppForegroundTracker.inForeground) {
      false
    } else {
      try {
        setForeground(foregroundInfo())
        true
      } catch (t: Throwable) {
        Log.w(TAG, "setForeground refused; running tick best-effort in background", t)
        false
      }
    }

    TickLiveness.alive = AppForegroundTracker.inForeground // headless ⇒ not yet proven alive
    return try {
      coroutineScope {
        val tick = async { SyncScheduler.runRegisteredTasks(applicationContext) }

        // Liveness gate: poll until JS signals, the tick settles, or the
        // window closes.
        withTimeoutOrNull(JS_LIVENESS_MS) {
          while (!TickLiveness.alive && tick.isActive) delay(500)
        }
        if (!TickLiveness.alive && tick.isActive) {
          tick.cancel()
          Log.w(TAG, "headless JS never started; retrying in a fresh process")
          exitHeadlessProcessSoon()
          return@coroutineScope Result.retry()
        }

        val cap = if (foregrounded) FOREGROUND_CAP_MS else BACKGROUND_CAP_MS
        val completed = withTimeoutOrNull(cap) {
          tick.await()
          true
        }
        if (completed == null) {
          Log.w(TAG, "tick hit ${cap}ms cap; interrupted run is reconciled on next launch")
        }
        Result.success()
      }
    } catch (t: Throwable) {
      Log.e(TAG, "tick failed", t)
      Result.failure(workDataOf("error" to (t.message ?: t.javaClass.name)))
    }
  }

  /**
   * The stalled headless process cannot recover (the app loader considers the
   * app already running, so future ticks would queue events forever). End it
   * once WorkManager has had time to persist the retry and stop the FGS; the
   * retry then spawns fresh. Never fires when an activity is around or JS
   * turned out alive after all.
   */
  private fun exitHeadlessProcessSoon() {
    Handler(Looper.getMainLooper()).postDelayed({
      if (!AppForegroundTracker.inForeground && !TickLiveness.alive) {
        Log.w(TAG, "exiting wedged headless process for a clean retry")
        Process.killProcess(Process.myPid())
      }
    }, 5_000)
  }

  private fun foregroundInfo(): ForegroundInfo {
    SyncNotifications.ensureChannel(applicationContext)
    val notification = SyncNotifications.ongoing(
      applicationContext,
      "copyparty",
      "Scheduled sync",
    )
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      ForegroundInfo(
        SyncNotifications.WORKER_NOTIF_ID,
        notification,
        ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
      )
    } else {
      ForegroundInfo(SyncNotifications.WORKER_NOTIF_ID, notification)
    }
  }
}
