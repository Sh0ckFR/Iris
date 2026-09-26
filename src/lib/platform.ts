/**
 * The system Iris runs on, known at once (from the webview) so the interface and the tool set
 * can adapt before any call to Rust: WebView2 on Windows, WKWebView on macOS and iOS,
 * WebKitGTK on Linux, the Android System WebView on Android.
 */

export type Platform = 'windows' | 'macos' | 'linux' | 'android' | 'ios';

export function detectPlatform(userAgent: string, touchPoints = 0): Platform {
  if (/android/i.test(userAgent)) return 'android';
  if (/iphone|ipad|ipod/i.test(userAgent)) return 'ios';
  if (/x11|linux|cros/i.test(userAgent)) return 'linux';
  // iPadOS presents itself as a Mac, but a Mac has no touch screen.
  if (/macintosh|mac os x/i.test(userAgent)) return touchPoints > 1 ? 'ios' : 'macos';
  return 'windows';
}

export const PLATFORM: Platform =
  typeof navigator === 'undefined' ? 'windows' : detectPlatform(navigator.userAgent, navigator.maxTouchPoints ?? 0);

/** Phones and tablets: one full-screen window, no tray, no control of other apps. */
export const IS_MOBILE = PLATFORM === 'android' || PLATFORM === 'ios';
export const IS_DESKTOP = !IS_MOBILE;

/** The system's name as users know it ("Start Iris with macOS"). */
export const OS_NAME: Record<Platform, string> = {
  windows: 'Windows',
  macos: 'macOS',
  linux: 'Linux',
  android: 'Android',
  ios: 'iOS',
};

/**
 * Tools that need a desktop: other apps, their windows, the screen, the volume, shell commands
 * and the Recycle Bin. Phones and tablets don't let an app do any of these, so they are not
 * offered there (the model would only get errors).
 */
export const DESKTOP_ONLY_TOOLS = new Set([
  'open_app',
  'set_volume',
  'delete_to_trash',
  'run_command',
  'control_window',
  'list_windows',
  'manage_window',
  'use_computer',
  'look_at_screen',
]);
