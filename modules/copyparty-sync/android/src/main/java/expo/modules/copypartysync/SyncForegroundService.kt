package expo.modules.copypartysync

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

/**
 * Real dataSync foreground service held for the duration of a sync run.
 *
 * Purpose: an ongoing *notification* alone (what the app shipped before) does
 * nothing for process lifetime — swiping the app away killed in-flight syncs
 * instantly. `startForeground()` is what raises the process above the
 * cached-app freezer / LMK, and the partial wake lock keeps the CPU (and JS
 * timers) running while the screen is off.
 *
 * Started by JS at run start (see src/sync/foreground.ts) and stopped in the
 * run's `finally`. `startForegroundService` throws on Android 12+ when the app
 * is background-started without an exemption — the module catches that and JS
 * falls back to the plain-notification path (best effort, same as before).
 */
class SyncForegroundService : Service() {
  companion object {
    private const val TAG = "CopypartySync"

    // Same integer slot the JS notification path uses (foreground.ts NOTIF_ID):
    // the FGS notification *replaces* the plain "Syncing…" one, never duplicates.
    const val NOTIF_ID = 1

    const val EXTRA_TITLE = "title"
    const val EXTRA_TEXT = "text"

    // dataSync services get a 6h-per-24h execution budget on Android 15; use
    // the same ceiling for the wake lock so neither outlives the other.
    private const val WAKE_LOCK_TIMEOUT_MS = 6L * 60 * 60 * 1000

    fun start(context: Context, title: String, text: String) {
      val intent = Intent(context, SyncForegroundService::class.java)
        .putExtra(EXTRA_TITLE, title)
        .putExtra(EXTRA_TEXT, text)
      // Throws ForegroundServiceStartNotAllowedException (API 31+) when a
      // background-started process lacks an exemption; caller handles it.
      ContextCompat.startForegroundService(context, intent)
    }

    fun stop(context: Context) {
      // Stopping the service also removes its notification.
      context.stopService(Intent(context, SyncForegroundService::class.java))
    }
  }

  private var wakeLock: PowerManager.WakeLock? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    SyncNotifications.ensureChannel(this)
    val notification = SyncNotifications.ongoing(
      this,
      intent?.getStringExtra(EXTRA_TITLE) ?: "copyparty",
      intent?.getStringExtra(EXTRA_TEXT) ?: "Syncing…",
    )
    // Must run within ~5s of startForegroundService or the system kills the
    // app; ServiceCompat handles the typed overload cutoffs across API levels.
    ServiceCompat.startForeground(
      this,
      NOTIF_ID,
      notification,
      ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
    )
    acquireWakeLock()
    // A run that died with the process must not resurrect an empty service.
    return START_NOT_STICKY
  }

  private fun acquireWakeLock() {
    if (wakeLock?.isHeld == true) return
    val pm = getSystemService(POWER_SERVICE) as PowerManager
    wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "copyparty:sync").apply {
      // Non-refcounted: one release() in onDestroy always suffices, even if
      // onStartCommand ran more than once.
      setReferenceCounted(false)
      acquire(WAKE_LOCK_TIMEOUT_MS)
    }
  }

  /**
   * Android 15 enforces the dataSync 6h/24h budget by calling onTimeout; the
   * service must stop itself promptly or the app ANRs. The interrupted run is
   * healed to status 'interrupted' by reconcileInterruptedRuns on next launch.
   */
  override fun onTimeout(startId: Int, fgsType: Int) {
    Log.w(TAG, "dataSync FGS budget exhausted; stopping sync service")
    stopForeground(STOP_FOREGROUND_REMOVE)
    stopSelf()
  }

  override fun onDestroy() {
    wakeLock?.takeIf { it.isHeld }?.release()
    wakeLock = null
    super.onDestroy()
  }

  override fun onBind(intent: Intent?): IBinder? = null
}
