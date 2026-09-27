package __PACKAGE__

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import java.util.Locale

/**
 * Keeps Iris listening when she is not on screen (scripts/mobile-setup.mjs installs it).
 *
 * Android stops giving the microphone to an app in the background unless it runs a foreground
 * service of type "microphone", started while the app was visible: this is that service. It
 * does no work itself (the webview keeps listening); it shows the ongoing notification Android
 * requires, with a "Quit" action, and stops when the activity is closed for good.
 */
class ListeningService : Service() {
  companion object {
    private const val TAG = "IrisListening"
    private const val CHANNEL = "iris-listening"
    private const val NOTIFICATION_ID = 7
    private const val ACTION_QUIT = "quit"

    /** Starts the service once the microphone is granted (Android refuses it otherwise). */
    fun start(context: Context) {
      if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) return
      try {
        ContextCompat.startForegroundService(context, Intent(context, ListeningService::class.java))
      } catch (e: Exception) {
        // Android 12+ refuses a start from the background: the next resume will retry.
        Log.w(TAG, "could not start the listening service", e)
      }
    }

    fun stop(context: Context) {
      context.stopService(Intent(context, ListeningService::class.java))
    }
  }

  private val french get() = Locale.getDefault().language == "fr"

  override fun onBind(intent: Intent?): IBinder? = null

  // Swiped out of the recent apps: closed for good, as with the back button.
  override fun onTaskRemoved(rootIntent: Intent?) {
    stopSelf()
    super.onTaskRemoved(rootIntent)
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_QUIT) {
      // Like "Quit Iris" in the desktop tray: the service and the app both end.
      ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
      stopSelf()
      android.os.Process.killProcess(android.os.Process.myPid())
      return START_NOT_STICKY
    }
    val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else 0
    try {
      ServiceCompat.startForeground(this, NOTIFICATION_ID, notification(), type)
    } catch (e: Exception) {
      Log.w(TAG, "could not enter the foreground", e)
      stopSelf()
    }
    return START_NOT_STICKY
  }

  private fun notification(): Notification {
    val manager = getSystemService(NotificationManager::class.java)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val name = if (french) "Écoute d'Iris" else "Iris listening"
      manager.createNotificationChannel(NotificationChannel(CHANNEL, name, NotificationManager.IMPORTANCE_LOW))
    }
    val flags = PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
    val open = packageManager.getLaunchIntentForPackage(packageName)?.let {
      PendingIntent.getActivity(this, 0, it, flags)
    }
    val quit = PendingIntent.getService(this, 1, Intent(this, ListeningService::class.java).setAction(ACTION_QUIT), flags)
    return NotificationCompat.Builder(this, CHANNEL)
      .setSmallIcon(android.R.drawable.ic_btn_speak_now)
      .setContentTitle(if (french) "Iris vous écoute" else "Iris is listening")
      .setContentText(if (french) "Dites « Iris » pour lui parler." else "Say “Iris” to talk to her.")
      .setOngoing(true)
      .setShowWhen(false)
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      .setContentIntent(open)
      .addAction(0, if (french) "Quitter" else "Quit", quit)
      .build()
  }
}
