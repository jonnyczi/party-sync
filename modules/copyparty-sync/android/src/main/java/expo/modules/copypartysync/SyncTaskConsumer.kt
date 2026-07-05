package expo.modules.copypartysync

import android.content.Context
import android.util.Log
import expo.modules.interfaces.taskManager.TaskConsumer
import expo.modules.interfaces.taskManager.TaskConsumerInterface
import expo.modules.interfaces.taskManager.TaskExecutionCallback
import expo.modules.interfaces.taskManager.TaskInterface
import expo.modules.interfaces.taskManager.TaskManagerUtilsInterface

/**
 * TaskConsumer bridging expo-task-manager's registry to our WorkManager
 * scheduling (SyncScheduler / SyncTaskWorker). Replaces expo-background-task's
 * BackgroundTaskConsumer, whose worker never promotes itself to a foreground
 * service — verified: the cached-app freezer froze the cold-spawned process
 * ~10s after spawn, before the JS bundle ran, so periodic sync silently
 * no-oped whenever the app had been swiped away.
 *
 * The (Context?, TaskManagerUtilsInterface?) constructor signature is
 * load-bearing: TaskService re-instantiates persisted consumers reflectively
 * with exactly those parameter types, including on headless cold starts.
 */
class SyncTaskConsumer(context: Context?, taskManagerUtils: TaskManagerUtilsInterface?) :
  TaskConsumer(context, taskManagerUtils), TaskConsumerInterface {

  companion object {
    private const val TAG = "CopypartySync"
    const val TASK_TYPE = "copyparty-sync"
    const val DEFAULT_INTERVAL_MINUTES = 15L
  }

  private var task: TaskInterface? = null

  override fun taskType(): String = TASK_TYPE

  /** Runs the registered JS task headlessly (expo-task-manager loads a
   *  headless React context when none is alive); `callback` fires when the JS
   *  defineTask body settles. */
  fun executeTask(callback: TaskExecutionCallback) {
    Log.d(TAG, "executing task '${task?.name}'")
    taskManagerUtils.executeTask(task, null, callback)
  }

  override fun didRegister(task: TaskInterface) {
    this.task = task
    SyncScheduler.schedule(context, intervalMinutes())
  }

  override fun didUnregister() {
    task = null
    SyncScheduler.cancel(context)
  }

  private fun intervalMinutes(): Long {
    @Suppress("UNCHECKED_CAST")
    val options = task?.options as? Map<String, Any?>
    return (options?.get("intervalMinutes") as? Number)?.toLong()
      ?: DEFAULT_INTERVAL_MINUTES
  }
}
