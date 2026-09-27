import { useSyncExternalStore } from 'react';

/**
 * How long Iris takes to answer a spoken request: from the end of the user's sentence to the
 * first sound of her reply (an acknowledgement counts — it is what the user hears). Shown in the
 * telemetry: the last one, and the median of the last few.
 */

const KEEP = 10;
let samples: number[] = [];
let snapshot: { last: number | null; median: number | null } = { last: null, median: null };
const listeners = new Set<() => void>();

export function recordVoiceLatency(ms: number) {
  if (!Number.isFinite(ms) || ms < 0 || ms > 60_000) return;
  samples = [...samples, ms].slice(-KEEP);
  const sorted = [...samples].sort((a, b) => a - b);
  snapshot = { last: ms, median: sorted[Math.floor(sorted.length / 2)] };
  console.warn(`[iris:latency] spoken request → first sound: ${(ms / 1000).toFixed(2)} s`);
  listeners.forEach((l) => l());
}

export function useVoiceLatency() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshot,
  );
}
