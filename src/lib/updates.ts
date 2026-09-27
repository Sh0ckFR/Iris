import { useEffect, useState, useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { getVersion } from '@tauri-apps/api/app';
import { IS_DESKTOP } from './platform';

/**
 * Updates (Windows, macOS, Linux): each GitHub Release carries a signed `latest.json`
 * (tauri-plugin-updater checks the signature against the public key in tauri.conf.json). Iris
 * looks once shortly after launch, and whenever asked in Settings; installing downloads the
 * new version, then restarts into it. Phones update through their store, and Linux packages
 * (.deb, .rpm, Flatpak) through the system's tools: only the AppImage updates itself there.
 */

export type UpdateState =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'none' }
  | { phase: 'available'; version: string; notes?: string }
  | { phase: 'downloading'; version: string; percent: number | null }
  | { phase: 'restarting'; version: string }
  | { phase: 'error'; message: string };

let state: UpdateState = { phase: 'idle' };
let pending: Update | null = null;
const listeners = new Set<() => void>();

function set(next: UpdateState) {
  state = next;
  listeners.forEach((l) => l());
}

/** This copy of Iris can update itself (asked once from Rust: it knows how Iris was installed). */
export const updatesSupported: Promise<boolean> = IS_DESKTOP ? invoke<boolean>('updates_supported').catch(() => false) : Promise.resolve(false);

export function useUpdatesSupported(): boolean {
  const [supported, setSupported] = useState(false);
  useEffect(() => void updatesSupported.then(setSupported), []);
  return supported;
}

/** Looks for a newer version; returns it, or null when Iris is up to date. */
export async function checkForUpdate(): Promise<string | null> {
  if (!(await updatesSupported) || state.phase === 'checking' || state.phase === 'downloading' || state.phase === 'restarting') return null;
  set({ phase: 'checking' });
  try {
    pending = await check({ timeout: 20_000 });
    if (!pending) {
      set({ phase: 'none' });
      return null;
    }
    set({ phase: 'available', version: pending.version, notes: pending.body ?? undefined });
    return pending.version;
  } catch (error) {
    set({ phase: 'error', message: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

/** Downloads and installs the version found by `checkForUpdate`, then restarts Iris. */
export async function installUpdate(): Promise<void> {
  if (!pending) return;
  const version = pending.version;
  let total = 0;
  let received = 0;
  set({ phase: 'downloading', version, percent: null });
  try {
    await pending.downloadAndInstall((event) => {
      if (event.event === 'Started') total = event.data.contentLength ?? 0;
      else if (event.event === 'Progress') {
        received += event.data.chunkLength;
        set({ phase: 'downloading', version, percent: total ? Math.min(100, Math.round((received / total) * 100)) : null });
      }
    });
    set({ phase: 'restarting', version });
    await relaunch();
  } catch (error) {
    set({ phase: 'error', message: error instanceof Error ? error.message : String(error) });
  }
}

/** This build's version ("0.2.0"). */
export const appVersion: Promise<string> = IS_DESKTOP ? getVersion().catch(() => '') : Promise.resolve('');

export function useUpdateState(): UpdateState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
}
