package __PACKAGE__

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.enableEdgeToEdge
import androidx.core.content.ContextCompat

// Iris: Tauri's MainActivity (edge to edge), plus the listening service (scripts/mobile-setup.mjs).
class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  // Visible again: the moment Android allows a microphone service to start (from the
  // background it refuses). Once the webview has the microphone, this keeps it when Iris leaves
  // the screen; the notification it needs is asked for once, on Android 13+.
  override fun onResume() {
    super.onResume()
    if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) return
    ListeningService.start(this)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
      ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
    ) {
      val prefs = getPreferences(MODE_PRIVATE)
      if (!prefs.getBoolean("askedNotifications", false)) {
        prefs.edit().putBoolean("askedNotifications", true).apply()
        requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 7)
      }
    }
  }

  // Closed for good (back out of the app, swiped away): Iris stops listening. Merely leaving
  // the screen (home, another app) keeps her listening.
  override fun onDestroy() {
    if (isFinishing) ListeningService.stop(this)
    super.onDestroy()
  }
}
