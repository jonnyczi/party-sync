package expo.modules.copypartysync

/**
 * Liveness handshake between SyncTaskWorker and the headless JS tick.
 *
 * Cold-starting the headless React context is not reliable: observed (release
 * build, Android 15) the JS bundle evaluation occasionally never completes —
 * all JS threads parked, no crash, no logs — while the exact same spawn path
 * works on other attempts. The stalled process cannot recover either: the
 * headless app loader records the app as "already running", so later ticks in
 * that process queue events forever.
 *
 * The JS task body calls markTickAlive() as its first statement. If the flag
 * hasn't flipped within the worker's liveness window, the worker concludes
 * the JS world is wedged, returns Result.retry(), and exits the (headless)
 * process so WorkManager's retry gets a fresh spawn — which is what the
 * successful attempts look like.
 */
object TickLiveness {
  @Volatile var alive: Boolean = false
}
