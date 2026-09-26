import { useSyncExternalStore } from 'react';
import { listChatModels } from './modelCatalog';
import type { CloudProvider, Settings } from './settings';
import type { Secrets } from './secrets';

/**
 * Picks each provider's models from what its key can actually use: the newest fast, inexpensive
 * model for the conversation (it answers every request, so it drives the token bill) and the
 * newest stronger one for visuals and code only. Matching families instead of fixed IDs keeps the
 * choice current as providers release models.
 */

export interface ModelPick {
  chat: string | null;
  builder: string | null;
}

/** Before a key's model list is known (or when it can't be fetched). */
export const FALLBACK_CHAT_MODELS: Record<CloudProvider, string> = {
  openai: 'gpt-5-mini',
  anthropic: 'claude-haiku-4-5',
  google: 'gemini-2.5-flash',
};

/** "5.2" → [5, 2], for comparing model generations. */
function version(v: string): number[] {
  return v.split('.').map(Number);
}

function newer(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/**
 * Newest ID whose version is captured by `pattern` (group 1); at the same version, stable beats
 * preview. (Stable first overall picked gemini-2.5-pro, which Google lists but refuses to new users,
 * while its successors stay in preview for months.) Models found unavailable are skipped.
 */
function newest(ids: string[], pattern: RegExp): string | null {
  const found = ids
    .filter((id) => !unavailable.has(id))
    .map((id) => ({ id, m: pattern.exec(id) }))
    .filter((x): x is { id: string; m: RegExpExecArray } => x.m !== null)
    .map(({ id, m }) => ({ id, v: version(m[1]), preview: /preview|exp/.test(id) }));
  found.sort((a, b) => newer(b.v, a.v) || Number(a.preview) - Number(b.preview));
  return found[0]?.id ?? null;
}

// ---------------------------------------------------------------- models that turned out unavailable

/**
 * Models a provider refused as gone ("no longer available to new users", "not found"): skipped by
 * the automatic choice from then on, which picks the next best one. Remembered on this computer.
 */
const UNAVAILABLE_KEY = 'iris.models.unavailable';
const unavailable = new Set<string>(
  (() => {
    try {
      return JSON.parse(localStorage.getItem(UNAVAILABLE_KEY) ?? '[]') as string[];
    } catch {
      return [];
    }
  })(),
);
let unavailableVersion = 0;
const unavailableListeners = new Set<() => void>();

export function markModelUnavailable(modelId: string) {
  if (unavailable.has(modelId)) return;
  unavailable.add(modelId);
  unavailableVersion++;
  try {
    localStorage.setItem(UNAVAILABLE_KEY, JSON.stringify([...unavailable]));
  } catch {
    // remembered this session only
  }
  console.warn(`[iris] ${modelId} is no longer available: another model is picked`);
  unavailableListeners.forEach((l) => l());
}

/** Changes whenever a model is found unavailable (the automatic choice then runs again). */
export function useUnavailableModels(): number {
  return useSyncExternalStore(
    (l) => {
      unavailableListeners.add(l);
      return () => {
        unavailableListeners.delete(l);
      };
    },
    () => unavailableVersion,
  );
}

export function pickModels(provider: CloudProvider, ids: string[]): ModelPick {
  switch (provider) {
    case 'openai':
      // "gpt-5-mini", "gpt-5.2", older "gpt-4o-mini"… (not -nano, too weak for tool calls, nor -pro, very expensive).
      return { chat: newest(ids, /^gpt-(\d+(?:\.\d+)?)o?-mini$/), builder: newest(ids, /^gpt-(\d+(?:\.\d+)?)o?$/) };
    case 'anthropic':
      // The Anthropic list is already newest first.
      return {
        chat: ids.find((id) => /haiku/.test(id) && !unavailable.has(id)) ?? null,
        builder: ids.find((id) => /sonnet/.test(id) && !unavailable.has(id)) ?? null,
      };
    case 'google':
      // "gemini-2.5-flash", "gemini-3-pro-preview"… (not -lite, -image…).
      return {
        chat: newest(ids, /^gemini-(\d+(?:\.\d+)?)-flash(?:-preview[\w-]*)?$/),
        builder: newest(ids, /^gemini-(\d+(?:\.\d+)?)-pro(?:-preview[\w-]*)?$/),
      };
  }
}

/** Model lists per key, fetched once per session (listing models costs no tokens, but takes time). */
const listed = new Map<string, Promise<string[]>>();

function modelsFor(provider: CloudProvider, apiKey: string): Promise<string[]> {
  const cacheKey = `${provider}:${apiKey}`;
  let list = listed.get(cacheKey);
  if (!list) {
    list = listChatModels(provider, apiKey).catch(() => {
      listed.delete(cacheKey); // retry next time (offline, provider down…)
      return [];
    });
    listed.set(cacheKey, list);
  }
  return list;
}

const PROVIDERS: CloudProvider[] = ['anthropic', 'openai', 'google'];

export type ModelPicks = Partial<Record<CloudProvider, ModelPick>>;

/** The models each saved key can use, picked by pickModels. */
export async function pickModelsForKeys(secrets: Secrets): Promise<ModelPicks> {
  const picks = await Promise.all(
    PROVIDERS.filter((p) => secrets[p]).map(async (p) => [p, pickModels(p, await modelsFor(p, secrets[p]!))] as const),
  );
  return Object.fromEntries(picks);
}

/**
 * The settings changes that match the saved keys: models of the providers left on "automatic",
 * and a brain provider that has a key. Returns null when nothing changes.
 */
export function applyModelPicks(settings: Settings, secrets: Secrets, picks: ModelPicks): Partial<Settings> | null {
  const cloudModels = { ...settings.cloudModels };
  const builderModels = { ...settings.builderModels };
  let changed = false;

  for (const provider of PROVIDERS) {
    const pick = picks[provider];
    if (!pick || !secrets[provider] || !settings.modelsAuto[provider]) continue;
    const chat = pick.chat ?? cloudModels[provider];
    // "Same as the conversation" when the stronger model is missing or is the same one.
    const builder = pick.builder && pick.builder !== chat ? pick.builder : '';
    if (chat !== cloudModels[provider] || builder !== builderModels[provider]) {
      cloudModels[provider] = chat;
      builderModels[provider] = builder;
      changed = true;
    }
  }

  // The chosen brain has no key: pick one that has, so Settings shows the provider really answering.
  const keyed = PROVIDERS.filter((p) => secrets[p]);
  const cloudProvider = secrets[settings.cloudProvider] || keyed.length === 0 ? settings.cloudProvider : keyed[0];

  if (!changed && cloudProvider === settings.cloudProvider) return null;
  return { cloudProvider, cloudModels, builderModels };
}
