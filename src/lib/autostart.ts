import { invoke } from '@tauri-apps/api/core';
import { IS_MOBILE } from './platform';

/**
 * Settings → "Start Iris with Windows / macOS / Linux": the login entry (tauri-plugin-autostart:
 * the registry, a LaunchAgent, an XDG autostart file) follows the setting — added when it's on,
 * removed when it's off, checked at every launch. Phones and tablets have no such entry.
 */
export async function syncAutostart(enabled: boolean): Promise<void> {
  if (IS_MOBILE) return;
  try {
    const registered = await invoke<boolean>('plugin:autostart|is_enabled');
    if (registered === enabled) return;
    await invoke(enabled ? 'plugin:autostart|enable' : 'plugin:autostart|disable');
    console.warn(`[iris:autostart] launch at startup ${enabled ? 'on' : 'off'}`);
  } catch (error) {
    // Removing an entry that is already gone is not a failure.
    if (!enabled && /introuvable|not find|not found|os error 2/i.test(String(error))) return;
    console.warn('[iris:autostart] could not update', error);
  }
}
