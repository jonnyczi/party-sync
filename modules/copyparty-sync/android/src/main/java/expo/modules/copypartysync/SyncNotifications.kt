package expo.modules.copypartysync

import android.app.Notification
import android.content.Context
import androidx.core.app.NotificationChannelCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

/**
 * Builds the silent "sync in progress" notifications this module attaches to
 * its foreground service / worker. Mirrors the channel + styling used by
 * `modules/copyparty-notify` (same channel id, so the user sees one "Sync in
 * progress" category in system settings) — duplicated rather than shared to
 * avoid a cross-module Gradle dependency.
 */
object SyncNotifications {
  const val CHANNEL_ID = "copyparty-sync"

  // Notification id map: 1 = sync-run FGS (SyncForegroundService, same slot the
  // JS notification path uses), 3 = periodic worker's ForegroundInfo,
  // 1_000_000+runId = result notifications (JS, notify-result.ts).
  const val WORKER_NOTIF_ID = 3

  /** Idempotent; createNotificationChannel no-ops when the channel exists. */
  fun ensureChannel(context: Context) {
    val channel = NotificationChannelCompat.Builder(
      CHANNEL_ID,
      NotificationManagerCompat.IMPORTANCE_LOW,
    )
      .setName("Sync in progress")
      .setSound(null, null)
      .setVibrationEnabled(false)
      .setShowBadge(false)
      .build()
    NotificationManagerCompat.from(context).createNotificationChannel(channel)
  }

  /** The ongoing/silent notification a foreground service is required to show. */
  fun ongoing(context: Context, title: String, text: String): Notification =
    NotificationCompat.Builder(context, CHANNEL_ID)
      .setSmallIcon(android.R.drawable.stat_notify_sync)
      .setContentTitle(title)
      .setContentText(text)
      .setStyle(NotificationCompat.BigTextStyle().bigText(text))
      .setOngoing(true)
      .setSilent(true)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .build()
}
