import { fetch as tauriFetch } from '@tauri-apps/plugin-http';

/**
 * Explicit context caching for Gemini. The instructions and tool definitions — the same at every
 * step of a request and from one request to the next — are stored once as a Gemini "cached
 * content" and billed at the cached rate each time they are used, instead of relying on the
 * implicit cache (which caught 0–25 % of the prompt in practice).
 *
 * It works below the AI SDK, as its fetch: a generateContent request whose instructions + tools
 * are already cached is rewritten to reference the cache (Gemini refuses them twice, and the SDK
 * would send both); tools still run normally since the SDK keeps their definitions.
 * A cache is made the first time a prefix is seen (the request's next steps use it), lives
 * 10 minutes, and is extended while it is used; if it vanished, the full request is sent again.
 */

const API = 'https://generativelanguage.googleapis.com/v1beta';
const TTL_S = 600;
/** Below ~1,000 tokens Gemini refuses explicit caching (and it would not be worth it). */
const MIN_PREFIX_CHARS = 4_000;
/** A refused prefix (too small for this model, quota…) is not tried again for this long. */
const RETRY_AFTER_MS = 3600_000;
const MAX_CACHES = 6;

interface Entry {
  name?: string;
  expiresAt: number;
  /** Creation refused until then. */
  failedUntil?: number;
  creating?: Promise<void>;
}

const caches = new Map<string, Entry>();

/** FNV-1a (53-bit) of a string: a cheap, stable key for a prefix. */
function hash(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x5bd1e995);
  }
  return `${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}`;
}

type Prefix = { systemInstruction?: unknown; tools?: unknown; toolConfig?: unknown };

async function create(key: string, model: string, prefix: Prefix, apiKey: string) {
  const entry: Entry = { expiresAt: 0 };
  caches.set(key, entry);
  // Oldest caches go first (they expire by themselves anyway).
  while (caches.size > MAX_CACHES) caches.delete(caches.keys().next().value!);
  entry.creating = (async () => {
    try {
      const response = await tauriFetch(`${API}/cachedContents`, {
        method: 'POST',
        headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: `models/${model}`, ...prefix, ttl: `${TTL_S}s` }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${(await response.text().catch(() => '')).slice(0, 200)}`);
      const data = (await response.json()) as { name: string; usageMetadata?: { totalTokenCount?: number } };
      entry.name = data.name;
      entry.expiresAt = Date.now() + TTL_S * 1000;
      console.warn(`[iris:cache] Gemini cache ready for ${model}: ${data.usageMetadata?.totalTokenCount ?? '?'} tokens of instructions + tools`);
    } catch (error) {
      entry.failedUntil = Date.now() + RETRY_AFTER_MS;
      console.warn(`[iris:cache] Gemini cache not created for ${model}`, error);
    } finally {
      entry.creating = undefined;
    }
  })();
}

/** Keeps a cache in use alive (fire and forget). */
function extend(entry: Entry, apiKey: string) {
  if (!entry.name || entry.expiresAt - Date.now() > (TTL_S * 1000) / 2) return;
  entry.expiresAt = Date.now() + TTL_S * 1000;
  void tauriFetch(`${API}/${entry.name}?updateMask=ttl`, {
    method: 'PATCH',
    headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ttl: `${TTL_S}s` }),
  }).catch(() => {});
}

/** The fetch given to the Gemini provider. */
export function geminiCachingFetch(apiKey: string): typeof globalThis.fetch {
  const plain = tauriFetch as unknown as typeof globalThis.fetch;
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const match = /\/models\/([^:/?]+):(?:stream)?[gG]enerateContent/.exec(url);
    if (!match || typeof init?.body !== 'string') return plain(input, init);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(init.body) as Record<string, unknown>;
    } catch {
      return plain(input, init);
    }
    if (body.cachedContent) return plain(input, init);

    const { systemInstruction, tools, toolConfig, ...rest } = body;
    const prefix: Prefix = { systemInstruction, tools, toolConfig };
    const prefixJson = JSON.stringify(prefix);
    if (prefixJson.length < MIN_PREFIX_CHARS) return plain(input, init);
    const model = match[1];
    const key = hash(`${model}|${prefixJson}`);
    const entry = caches.get(key);

    if (entry?.name && entry.expiresAt - Date.now() > 30_000) {
      const response = await plain(input, { ...init, body: JSON.stringify({ ...rest, cachedContent: entry.name }) });
      if (response.ok) {
        extend(entry, apiKey);
        return response;
      }
      // The cache is gone (expired, deleted): forget it and send the full request.
      console.warn(`[iris:cache] Gemini cache refused (HTTP ${response.status}); sending the full request`);
      caches.delete(key);
      return plain(input, init);
    }

    const refused = entry?.failedUntil && entry.failedUntil > Date.now();
    // Created at once (in the background): the next step of this request — a few seconds later,
    // after its tools ran — already uses it. (Waiting for a second sighting left 2-step requests
    // without any cache.)
    const alive = entry?.name && entry.expiresAt > Date.now();
    if (!refused && !entry?.creating && !alive) void create(key, model, prefix, apiKey);
    return plain(input, init);
  };
}
