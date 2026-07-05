package expo.modules.copypartysync

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings

/**
 * One-tap shortcuts into the system settings screens the health checklist's
 * "Fix" buttons target. Every intent falls back to the app-details page when
 * an OEM build doesn't ship the specific settings activity.
 */
object SettingsIntents {
  /** The direct system Allow/Deny dialog for the battery-optimization
   *  exemption. Requires REQUEST_IGNORE_BATTERY_OPTIMIZATIONS (declared via
   *  app.json). */
  fun requestIgnoreBatteryOptimizations(context: Context) {
    launch(
      context,
      Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
        .setData(Uri.parse("package:${context.packageName}")),
    )
  }

  fun openNotificationSettings(context: Context) {
    launch(
      context,
      Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
        .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName),
    )
  }

  /** The per-app "unrestricted data" page inside Data Saver settings. */
  fun openDataSaverSettings(context: Context) {
    launch(
      context,
      Intent(Settings.ACTION_IGNORE_BACKGROUND_DATA_RESTRICTIONS_SETTINGS)
        .setData(Uri.parse("package:${context.packageName}")),
    )
  }

  fun openAppSettings(context: Context) {
    launch(context, appDetailsIntent(context))
  }

  private fun appDetailsIntent(context: Context): Intent =
    Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
      .setData(Uri.parse("package:${context.packageName}"))

  private fun launch(context: Context, intent: Intent) {
    // Launched from the application context when no activity is handy —
    // requires NEW_TASK. (Harmless when an activity context is used.)
    // try/catch rather than resolveActivity: package-visibility filtering on
    // API 30+ can false-negative resolution for settings intents.
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    try {
      context.startActivity(intent)
    } catch (e: ActivityNotFoundException) {
      context.startActivity(appDetailsIntent(context).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
  }
}
