import { useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { EmbedRequest, EmbedResponse } from '../features/assistant/embed.worker';
import { memoryStore } from './memory';
import { knowledgeStore } from './knowledge';

/**
 * Memory search by meaning. Every fact, conversation summary, relation of the knowledge graph
 * and message the user said gets an embedding (embed.worker.ts, on this device); a question is
 * then compared with all of them — "le mariage de ma sœur" finds "Julie se marie le 12 juin",
 * whatever the words and the language. Used by recall_memory, and before each request to bring
 * the few memories that matter (beyond the recent facts always in the instructions).
 *
 * The embeddings are kept on disk (`<app data>/memory/embeddings.json`), 8-bit quantized
 * (384 bytes a text), computed only for texts not seen yet; they are derived data, never synced.
 */

// Keep in sync with embed.worker.ts.
const MODEL = 'Xenova/multilingual-e5-small';
const DIMS = 384;
const FILE = 'embeddings';
/** Archived messages indexed (the user's own, newest first): the rest stays keyword-searchable. */
const MAX_MESSAGES = 1500;
const BATCH = 16;

export type MemoryKind = 'fact' | 'journal' | 'relation' | 'message';

export interface MemoryItem {
  kind: MemoryKind;
  text: string;
  at: number;
}

export interface SemanticHit extends MemoryItem {
  score: number;
}

export type SemanticState = { phase: 'off' | 'idle' | 'downloading' | 'indexing' | 'ready' | 'error'; progress?: number; indexed: number; total: number; error?: string };

let enabled = false;
let vectors = new Map<string, Int8Array>();
let loadedFile: Promise<void> | null = null;
let state: SemanticState = { phase: 'off', indexed: 0, total: 0 };
const listeners = new Set<() => void>();

function setState(patch: Partial<SemanticState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

// ---------------------------------------------------------------- vectors

/** A short, stable key for a text (FNV-1a, 52 bits). */
export function textKey(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return `${h1.toString(36)}${(h2 & 0xfffff).toString(36)}`;
}

/** Unit vector → 8-bit (the dot product of two, / 127², is their cosine within ~1 %). */
export function quantize(v: Float32Array): Int8Array {
  const q = new Int8Array(v.length);
  for (let i = 0; i < v.length; i++) q[i] = Math.max(-127, Math.min(127, Math.round(v[i] * 127)));
  return q;
}

export function similarity(stored: Int8Array, query: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < stored.length; i++) dot += stored[i] * query[i];
  return dot / 127;
}

const toBase64 = (q: Int8Array) => btoa(String.fromCharCode(...new Uint8Array(q.buffer, q.byteOffset, q.byteLength)));
const fromBase64 = (s: string) => new Int8Array(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)).buffer);

// ---------------------------------------------------------------- the worker

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (v: Float32Array[]) => void; reject: (e: Error) => void }>();

function embed(texts: string[], kind: EmbedRequest['kind']): Promise<Float32Array[]> {
  if (!worker) {
    worker = new Worker(new URL('../features/assistant/embed.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<EmbedResponse>) => {
      const msg = e.data;
      if ('progress' in msg) {
        setState({ phase: 'downloading', progress: msg.progress });
        return;
      }
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if ('vectors' in msg) p?.resolve(msg.vectors);
      else p?.reject(new Error(msg.error));
    };
    worker.onerror = (e) => {
      pending.forEach((p) => p.reject(new Error(e.message || 'the embedding worker stopped')));
      pending.clear();
      worker?.terminate();
      worker = null;
    };
  }
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker!.postMessage({ id, texts, kind } satisfies EmbedRequest);
  });
}

// ---------------------------------------------------------------- what is indexed

/** Everything the search covers, newest first. */
export function memoryItems(): MemoryItem[] {
  const facts = memoryStore.facts().map((f) => ({ kind: 'fact' as const, text: f.text, at: f.createdAt }));
  const journal = memoryStore.journal().map((j) => ({ kind: 'journal' as const, text: j.summary, at: j.at }));
  const relations = knowledgeStore.relationSentences().map((r) => ({ kind: 'relation' as const, text: r.text, at: r.at }));
  const messages = memoryStore
    .archive()
    .filter((m) => m.role === 'user' && m.content.length >= 12)
    .slice(-MAX_MESSAGES)
    .map((m) => ({ kind: 'message' as const, text: m.content.slice(0, 600), at: m.at }));
  return [...facts, ...journal, ...relations, ...messages].sort((a, b) => b.at - a.at);
}

async function loadFile() {
  loadedFile ??= (async () => {
    try {
      const raw = await invoke<string | null>('memory_read', { name: FILE });
      const data = raw ? (JSON.parse(raw) as { model?: string; entries?: Record<string, string> }) : null;
      if (data?.model === MODEL && data.entries) vectors = new Map(Object.entries(data.entries).map(([k, v]) => [k, fromBase64(v)]));
    } catch (error) {
      console.warn('[iris:semantic] could not read the embeddings', error);
    }
  })();
  return loadedFile;
}

let saveTimer: number | undefined;
function save() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    // Only the texts still in memory are kept.
    const live = new Set(memoryItems().map((i) => textKey(i.text)));
    const entries: Record<string, string> = {};
    vectors.forEach((v, k) => {
      if (live.has(k)) entries[k] = toBase64(v);
    });
    invoke('memory_write', { name: FILE, content: JSON.stringify({ model: MODEL, dims: DIMS, entries }) }).catch((error) =>
      console.warn('[iris:semantic] could not save the embeddings', error),
    );
  }, 3000);
}

let indexing: Promise<void> | null = null;

/** Embeds what isn't yet (in the background, a batch at a time). */
function indexMissing(): Promise<void> {
  if (!enabled) return Promise.resolve();
  indexing ??= (async () => {
    try {
      await Promise.all([memoryStore.load(), loadFile()]);
      const items = memoryItems();
      const missing = [...new Set(items.map((i) => i.text).filter((t) => !vectors.has(textKey(t))))];
      setState({ total: items.length, indexed: items.length - missing.length });
      if (missing.length) setState({ phase: 'indexing' });
      for (let i = 0; i < missing.length && enabled; i += BATCH) {
        const batch = missing.slice(i, i + BATCH);
        const result = await embed(batch, 'passage');
        batch.forEach((text, j) => vectors.set(textKey(text), quantize(result[j])));
        setState({ phase: 'indexing', indexed: items.length - missing.length + i + batch.length });
        save();
      }
      if (enabled) setState({ phase: 'ready', error: undefined });
    } catch (error) {
      setState({ phase: 'error', error: error instanceof Error ? error.message : String(error) });
      console.warn('[iris:semantic] indexing failed', error);
    } finally {
      indexing = null;
    }
  })();
  return indexing;
}

let unsubscribe: (() => void) | null = null;
let changeTimer: number | undefined;

export const semanticMemory = {
  /** Follows the setting: on → the index is loaded and completed in the background. */
  configure(on: boolean) {
    if (on === enabled) return;
    enabled = on;
    unsubscribe?.();
    unsubscribe = null;
    if (!on) {
      setState({ phase: 'off' });
      worker?.terminate();
      worker = null;
      return;
    }
    setState({ phase: 'idle' });
    // New memories are indexed a little after they appear.
    const soon = () => {
      window.clearTimeout(changeTimer);
      changeTimer = window.setTimeout(() => void indexMissing(), 5000);
    };
    const offMemory = memoryStore.subscribe(soon);
    const offGraph = knowledgeStore.subscribe(soon);
    unsubscribe = () => (offMemory(), offGraph());
    // After the launch rush (Whisper, the voices).
    window.setTimeout(() => void indexMissing(), 20_000);
  },

  get ready() {
    return enabled && vectors.size > 0;
  },

  /** The memories closest in meaning to `query` (best first), above `minScore`. */
  async search(query: string, { limit = 8, minScore = 0.8, kinds }: { limit?: number; minScore?: number; kinds?: MemoryKind[] } = {}): Promise<SemanticHit[]> {
    if (!enabled || !query.trim()) return [];
    await loadFile();
    if (vectors.size === 0) return [];
    const [q] = await embed([query], 'query');
    const hits: SemanticHit[] = [];
    const seen = new Set<string>();
    for (const item of memoryItems()) {
      if (kinds && !kinds.includes(item.kind)) continue;
      const key = textKey(item.text);
      const v = vectors.get(key);
      if (!v || seen.has(key)) continue;
      seen.add(key);
      const score = similarity(v, q);
      if (score >= minScore) hits.push({ ...item, score });
    }
    hits.sort((a, b) => b.score - a.score);
    // Close to the best match only: a weak tail is noise.
    const best = hits[0]?.score ?? 0;
    return hits.filter((h) => h.score >= best - 0.06).slice(0, limit);
  },

  /**
   * The few memories worth adding to a request (facts, past conversations, relations) that are
   * not already in the instructions; empty when the index isn't ready or nothing is close. Never
   * slows a request down by more than `timeoutMs`.
   */
  async relevantFor(text: string, alreadyKnown: Set<string>, timeoutMs = 300): Promise<string | undefined> {
    if (!this.ready || text.trim().length < 6) return undefined;
    const search = this.search(text, { limit: 6, minScore: 0.84, kinds: ['fact', 'journal', 'relation'] }).catch(() => []);
    const hits = await Promise.race([search, new Promise<SemanticHit[]>((resolve) => window.setTimeout(() => resolve([]), timeoutMs))]);
    const day = (at: number) => new Date(at).toLocaleDateString(navigator.language, { day: 'numeric', month: 'short', year: 'numeric' });
    const lines = hits
      .filter((h) => !alreadyKnown.has(h.text))
      .slice(0, 4)
      .map((h) => `- (${h.kind === 'journal' ? `conversation of ${day(h.at)}` : h.kind}) ${h.text.slice(0, 300)}`);
    return lines.length ? lines.join('\n') : undefined;
  },

  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

export function useSemanticState(): SemanticState {
  return useSyncExternalStore(semanticMemory.subscribe, () => state);
}
