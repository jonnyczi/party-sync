package expo.modules.copypartysync

import android.app.ActivityManager
import android.app.usage.UsageStatsManager
import android.content.Context
import android.net.ConnectivityManager
import android.os.Build
import android.os.PowerManager

/**
 * Read-only probes for the background-sync health checklist. Each answers one
 * question: "is this device setting going to stop or degrade background sync?"
 */
object DeviceProbes {
  /** Battery-optimization exemption — the load-bearing setting: it permits
   *  foreground-service starts from the background (the headless periodic
   *  worker's setForeground) and relaxes Doze network/wake-lock limits. */
  fun isIgnoringBatteryOptimizations(context: Context): Boolean {
    val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
    return pm.isIgnoringBatteryOptimizations(context.packageName)
  }

  /** The user set "Restricted" in App info → Battery: WorkManager jobs stop
   *  running entirely. */
  fun isBackgroundRestricted(context: Context): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return false
    val am = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
    return am.isBackgroundRestricted
  }

  /**
   * Data Saver state, only meaningful on a metered connection:
   * 'enabled' = background data restricted (the respect_data_saver job toggle
   * will skip runs), 'whitelisted' = Data Saver on but this app may use
   * unrestricted data, 'disabled' = Data Saver off.
   */
  fun getDataSaverStatus(context: Context): String {
    val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    return when (cm.restrictBackgroundStatus) {
      ConnectivityManager.RESTRICT_BACKGROUND_STATUS_ENABLED -> "enabled"
      ConnectivityManager.RESTRICT_BACKGROUND_STATUS_WHITELISTED -> "whitelisted"
      else -> "disabled"
    }
  }

  /** Standby bucket — informational; 'rare'/'restricted' means Android will
   *  defer scheduled jobs substantially. */
  fun getAppStandbyBucket(context: Context): String {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return "unknown"
    val usm = context.getSystemService(Context.USAGE_STATS_SERVICE) as UsageStatsManager
    return when (usm.appStandbyBucket) {
      UsageStatsManager.STANDBY_BUCKET_ACTIVE -> "active"
      UsageStatsManager.STANDBY_BUCKET_WORKING_SET -> "working_set"
      UsageStatsManager.STANDBY_BUCKET_FREQUENT -> "frequent"
      UsageStatsManager.STANDBY_BUCKET_RARE -> "rare"
      45 /* STANDBY_BUCKET_RESTRICTED, API 30 */ -> "restricted"
      else -> "unknown"
    }
  }

  fun getManufacturer(): String = Build.MANUFACTURER.lowercase()
}
