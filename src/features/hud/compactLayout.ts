import { useSyncExternalStore } from 'react';

/**
 * Compact layout, for phones and small windows: there is no room for floating panels side by
 * side, so the panels fill the space between the top bar and the dock, one at a time, chosen
 * with tabs. Nothing is left out: the conversation, the knowledge graph, the telemetry, the
 * cards, the visual and the dashboards all stay one tap away.
 */

export const COMPACT_QUERY = '(max-width: 900px), (max-height: 560px)';

export type CompactTab = 'eye' | 'conversation' | 'knowledge' | 'telemetry' | 'briefing' | 'visual' | 'dashboard';

const media = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(COMPACT_QUERY) : null;

/** The compact layout is on (for code outside React, e.g. the panel tools). */
export const isCompact = () => media?.matches ?? false;

export function useCompactLayout(): boolean {
  return useSyncExternalStore(
    (fn) => {
      media?.addEventListener('change', fn);
      return () => media?.removeEventListener('change', fn);
    },
    isCompact,
  );
}

// ------------------------------------------------------------------ the tab on screen

let tab: CompactTab = 'conversation';
const listeners = new Set<() => void>();

/** Shows a panel in the compact layout (a new card or visual, Iris showing a panel…). */
export function setCompactTab(next: CompactTab) {
  if (next === tab) return;
  tab = next;
  listeners.forEach((fn) => fn());
}

export const compactTab = () => tab;

export function useCompactTab(): CompactTab {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    compactTab,
  );
}
