import { invoke } from '@tauri-apps/api/core';
import { IS_MOBILE } from './platform';

/**
 * Settings → "Start Iris with Windows / macOS / Linux": the login entry (the registry, a
 * LaunchAgent, an XDG autostart file — `flatpak run` inside Flatpak) follows the setting —
 * added when it's on, removed when it's off, checked at every launch. Phones and tablets have
 * no such entry. The Rust `autostart` command answers whether the entry is there afterwards.
 */
export async function syncAutostart(enabled: boolean): Promise<void> {
  if (IS_MOBILE) return;
  try {
    const registered = await invoke<boolean>('autostart', { enable: enabled });
    if (registered !== enabled) console.warn(`[iris:autostart] asked ${enabled ? 'on' : 'off'}, still ${registered ? 'on' : 'off'}`);
  } catch (error) {
    // Removing an entry that is already gone is not a failure.
    if (!enabled && /introuvable|not find|not found|os error 2/i.test(String(error))) return;
    console.warn('[iris:autostart] could not update', error);
  }
}
