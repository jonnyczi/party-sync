package expo.modules.copypartysync

/**
 * Whether any of the app's activities is currently resumed. Set from the
 * module's OnActivityEntersForeground/Background lifecycle hooks. A headless
 * process (WorkManager cold start) never runs those hooks, so this is `false`
 * exactly when cached-app-freezer protection is needed — the periodic worker
 * uses it to decide whether `setForeground()` is worth attempting.
 */
object AppForegroundTracker {
  @Volatile var inForeground: Boolean = false
}
