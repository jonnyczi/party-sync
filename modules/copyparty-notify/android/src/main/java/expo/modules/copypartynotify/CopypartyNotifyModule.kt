package expo.modules.copypartynotify

import android.content.Context
import androidx.core.app.NotificationChannelCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Minimal, FOSS-only local notifications backed entirely by `androidx.core`.
 * This exists to replace `expo-notifications`, whose Android build pulls in
 * `com.google.firebase:firebase-messaging` (a hard F-Droid blocker) even when
 * only local notifications are used. We post exactly one ongoing low-importance
 * "sync in progress" notification, so the surface is deliberately tiny.
 *
 * Android-only: the JS side uses `requireOptionalNativeModule`, so on iOS/web
 * the native object is null and the caller no-ops.
 */
class CopypartyNotifyModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("CopypartyNotify")

    AsyncFunction("setChannel") { channelId: String, name: String, importance: String ->
      setChannel(channelId, name, importance)
    }

    AsyncFunction("notify") {
        channelId: String, notifId: Int, title: String, body: String, ongoing: Boolean ->
      notify(channelId, notifId, title, body, ongoing)
    }

    AsyncFunction("dismiss") { notifId: Int ->
      NotificationManagerCompat.from(context).cancel(notifId)
    }
  }

  private val context: Context
    get() = appContext.reactContext
      ?: throw NotifyException("react context unavailable")

  private fun importanceValue(importance: String): Int = when (importance) {
    "min" -> NotificationManagerCompat.IMPORTANCE_MIN
    "low" -> NotificationManagerCompat.IMPORTANCE_LOW
    "high" -> NotificationManagerCompat.IMPORTANCE_HIGH
    else -> NotificationManagerCompat.IMPORTANCE_DEFAULT
  }

  /** Idempotent: createNotificationChannel is a no-op if the channel exists.
   *  Channels are an Android O+ concept; the Compat wrapper ignores them on
   *  older versions. Silent + no badge + no vibration to match a background
   *  progress indicator. */
  private fun setChannel(channelId: String, name: String, importance: String) {
    val channel = NotificationChannelCompat.Builder(channelId, importanceValue(importance))
      .setName(name)
      .setSound(null, null)
      .setVibrationEnabled(false)
      .setShowBadge(false)
      .build()
    NotificationManagerCompat.from(context).createNotificationChannel(channel)
  }

  private fun notify(
    channelId: String,
    notifId: Int,
    title: String,
    body: String,
    ongoing: Boolean,
  ) {
    val notification = NotificationCompat.Builder(context, channelId)
      // System sync glyph — avoids bundling a custom drawable and is available
      // on every API level.
      .setSmallIcon(android.R.drawable.stat_notify_sync)
      .setContentTitle(title)
      .setContentText(body)
      .setOngoing(ongoing)
      .setSilent(true)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .build()
    // No-ops (logs) when POST_NOTIFICATIONS is denied on API 33+; never throws.
    NotificationManagerCompat.from(context).notify(notifId, notification)
  }
}

private class NotifyException(message: String) : CodedException(message)
