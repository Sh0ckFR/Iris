import { useSyncExternalStore } from 'react';

/**
 * Panels the user (or Iris) hid: the conversation and the knowledge graph. Remembered between
 * sessions. The briefing and visual panels simply close (their content stays in the conversation).
 */

const KEY = 'iris.panels.hidden';

function load(): Set<string> {
  try {
    const raw = localStorage.getItem(KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

let hidden = load();
const listeners = new Set<() => void>();

export function setPanelHidden(id: string, value: boolean) {
  if (hidden.has(id) === value) return;
  hidden = new Set(hidden); // new snapshot for useSyncExternalStore
  if (value) hidden.add(id);
  else hidden.delete(id);
  try {
    localStorage.setItem(KEY, JSON.stringify([...hidden]));
  } catch {
    // Non-fatal: not remembered next time.
  }
  listeners.forEach((fn) => fn());
}

export const isPanelHidden = (id: string) => hidden.has(id);

export function useHiddenPanels(): ReadonlySet<string> {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => hidden,
  );
}
