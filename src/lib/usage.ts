import { useSyncExternalStore } from 'react';
import { costStore } from './costs';

/**
 * What Iris has consumed since the app started, shown in the HUD telemetry: the point is to
 * see where tokens go (and that caching and local answers work).
 */
export interface UsageTotals {
  /** Calls to a text model (each tool step counts). */
  requests: number;
  inputTokens: number;
  /** Part of inputTokens read from the provider's prompt cache (much cheaper). */
  cachedInputTokens: number;
  outputTokens: number;
  /** OpenAI Realtime (premium voice mode). */
  realtimeResponses: number;
  audioInputTokens: number;
  audioOutputTokens: number;
  /** Characters sent to OpenAI text-to-speech. */
  ttsCharacters: number;
  /** Requests answered on this computer without any AI call. */
  localAnswers: number;
}

const EMPTY: UsageTotals = {
  requests: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  realtimeResponses: 0,
  audioInputTokens: 0,
  audioOutputTokens: 0,
  ttsCharacters: 0,
  localAnswers: 0,
};

let totals = EMPTY;
const listeners = new Set<() => void>();

function add(delta: Partial<UsageTotals>) {
  const next = { ...totals };
  for (const [key, value] of Object.entries(delta) as [keyof UsageTotals, number][]) next[key] += value || 0;
  totals = next;
  listeners.forEach((l) => l());
}

/** Shape of the AI SDK's `totalUsage` (the parts used here). */
interface TextUsage {
  inputTokens?: number;
  outputTokens?: number;
  inputTokenDetails?: { cacheReadTokens?: number };
}

/** `savedToolTokens`: tool definitions not sent thanks to the dynamic selection (for the money saved). */
export function recordTextUsage(label: string, usage: TextUsage | undefined, steps = 1, savedToolTokens = 0) {
  if (!usage) return;
  const cached = usage.inputTokenDetails?.cacheReadTokens ?? 0;
  add({ requests: steps, inputTokens: usage.inputTokens ?? 0, cachedInputTokens: cached, outputTokens: usage.outputTokens ?? 0 });
  costStore.recordText(label, usage.inputTokens ?? 0, cached, usage.outputTokens ?? 0, savedToolTokens);
  // Dev log (console.warn is forwarded there, like the voice diagnostics).
  console.warn(
    `[iris:usage] ${label}: in ${usage.inputTokens ?? '?'} (cache ${cached}) / out ${usage.outputTokens ?? '?'}${steps > 1 ? ` · ${steps} steps` : ''}`,
  );
}

/** `response.usage` of an OpenAI Realtime `response.done` event. */
export interface RealtimeUsage {
  input_tokens?: number;
  output_tokens?: number;
  input_token_details?: { cached_tokens?: number; audio_tokens?: number };
  output_token_details?: { audio_tokens?: number };
}

export function recordRealtimeUsage(usage: RealtimeUsage | undefined) {
  if (!usage) return;
  add({
    realtimeResponses: 1,
    inputTokens: usage.input_tokens ?? 0,
    cachedInputTokens: usage.input_token_details?.cached_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    audioInputTokens: usage.input_token_details?.audio_tokens ?? 0,
    audioOutputTokens: usage.output_token_details?.audio_tokens ?? 0,
  });
  costStore.recordRealtime(
    usage.input_tokens ?? 0,
    usage.input_token_details?.cached_tokens ?? 0,
    usage.output_tokens ?? 0,
    usage.input_token_details?.audio_tokens ?? 0,
    usage.output_token_details?.audio_tokens ?? 0,
  );
  console.warn(
    `[iris:usage] Realtime: in ${usage.input_tokens ?? '?'} (cache ${usage.input_token_details?.cached_tokens ?? 0}, audio ${usage.input_token_details?.audio_tokens ?? 0}) / out ${usage.output_tokens ?? '?'} (audio ${usage.output_token_details?.audio_tokens ?? 0})`,
  );
}

export function recordTts(characters: number) {
  add({ ttsCharacters: characters });
  costStore.recordTts(characters);
}

export function recordLocalAnswer(what: string) {
  add({ localAnswers: 1 });
  console.warn(`[iris:usage] answered locally (0 token): ${what}`);
}

export function useUsage(): UsageTotals {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => totals,
  );
}
