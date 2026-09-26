import { useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { terms } from '../features/assistant/web';
import { knowledgeStore } from './knowledge';

/**
 * Long-term memory, kept on disk (app data folder, see src-tauri/src/memory.rs):
 *  - facts: what Iris knows about the user (said explicitly, or noticed in conversations);
 *  - journal: a summary of each past conversation;
 *  - archive: the text of past conversations, searched by keywords (recall_memory);
 *  - conversation: the current conversation and its rolling summary, restored at launch.
 */

export interface MemoryFact {
  id: string;
  text: string;
  createdAt: number;
  /** `user`: asked to remember; `auto`: noticed in a conversation. */
  source: 'user' | 'auto';
}

export interface JournalEntry {
  at: number;
  summary: string;
}

export interface ArchivedMessage {
  at: number;
  role: 'user' | 'assistant';
  content: string;
}

/** A conversation as saved to disk (text only: no cards, no document bytes). */
export interface StoredConversation {
  messages: { id: string; role: 'user' | 'assistant'; content: string; brain?: string }[];
  /** Summary of the messages up to `coveredId` (they are no longer sent to the model). */
  summary: { text: string; coveredId: string } | null;
}

/** Facts given to the model with every request (the rest is reachable with recall_memory). */
const PROMPT_FACTS = 40;
const PROMPT_CHARS = 2500;
const MAX_ARCHIVE = 3000;
const MAX_JOURNAL = 300;

let facts: MemoryFact[] = [];
let journal: JournalEntry[] = [];
let archive: ArchivedMessage[] = [];
let loaded: Promise<void> | null = null;
const listeners = new Set<() => void>();

async function read<T>(name: string, fallback: T): Promise<T> {
  try {
    const raw = await invoke<string | null>('memory_read', { name });
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch (error) {
    console.warn(`[iris:memory] could not read ${name}`, error);
    return fallback;
  }
}

function write(name: string, value: unknown) {
  invoke('memory_write', { name, content: JSON.stringify(value) }).catch((error) =>
    console.warn(`[iris:memory] could not save ${name}`, error),
  );
}

function changed() {
  snapshot = { facts, journalEntries: journal.length, archivedMessages: archive.length };
  listeners.forEach((l) => l());
}

const normalize = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

/** How well a text matches a query: shared significant words. */
function score(text: string, wanted: Set<string>): number {
  let n = 0;
  new Set(terms(text)).forEach((w) => {
    if (wanted.has(w)) n++;
  });
  return n;
}

let snapshot = { facts, journalEntries: 0, archivedMessages: 0 };

export const memoryStore = {
  /** Loads everything once (at launch); later calls wait for the same load. */
  load(): Promise<void> {
    loaded ??= (async () => {
      [facts, journal, archive] = await Promise.all([
        read<MemoryFact[]>('facts', []),
        read<JournalEntry[]>('journal', []),
        read<ArchivedMessage[]>('archive', []),
        knowledgeStore.load(),
      ]);
      changed();
    })();
    return loaded;
  },

  facts: () => facts,

  /** Adds a fact unless an equivalent one is already known. Returns false if it was a duplicate. */
  addFact(text: string, source: MemoryFact['source']): boolean {
    const clean = text.trim().replace(/\s+/g, ' ');
    if (clean.length < 3) return false;
    const n = normalize(clean);
    if (facts.some((f) => normalize(f.text) === n || normalize(f.text).includes(n))) return false;
    facts = [...facts, { id: `f-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, text: clean, createdAt: Date.now(), source }];
    write('facts', facts);
    changed();
    return true;
  },

  removeFact(id: string) {
    facts = facts.filter((f) => f.id !== id);
    write('facts', facts);
    changed();
  },

  /** Removes the facts matching a description ("my manager", "the diet"); returns them. */
  forget(what: string): MemoryFact[] {
    const wanted = new Set(terms(what));
    const n = normalize(what);
    const removed = facts.filter((f) => normalize(f.text).includes(n) || (wanted.size > 0 && score(f.text, wanted) >= Math.min(2, wanted.size)));
    if (removed.length) {
      facts = facts.filter((f) => !removed.includes(f));
      write('facts', facts);
      changed();
    }
    return removed;
  },

  /** Forgets everything: facts, journal, archive and knowledge graph (the current conversation is cleared separately). */
  clearAll() {
    facts = [];
    journal = [];
    archive = [];
    knowledgeStore.clear();
    write('facts', facts);
    write('journal', journal);
    write('archive', archive);
    changed();
  },

  /** A finished conversation: its summary goes to the journal, its text to the archive. */
  archiveConversation(messages: { role: 'user' | 'assistant'; content: string }[], summary: string | null) {
    const at = Date.now();
    if (summary) journal = [...journal, { at, summary }].slice(-MAX_JOURNAL);
    archive = [...archive, ...messages.filter((m) => m.content).map((m) => ({ at, role: m.role, content: m.content.slice(0, 2000) }))].slice(-MAX_ARCHIVE);
    if (summary) write('journal', journal);
    write('archive', archive);
    changed();
  },

  lastJournalEntry: (): JournalEntry | null => journal[journal.length - 1] ?? null,

  /**
   * What Iris knows about the user, for the (cached) instructions: the most recent facts,
   * within a size budget. Empty when nothing is known.
   */
  promptFacts(): string {
    const lines: string[] = [];
    let size = 0;
    for (const f of [...facts].reverse().slice(0, PROMPT_FACTS)) {
      if (size + f.text.length > PROMPT_CHARS) break;
      lines.unshift(`- ${f.text}`);
      size += f.text.length + 3;
    }
    return lines.join('\n');
  },

  /**
   * Keyword search over facts, past conversation summaries and archived messages (recall_memory),
   * plus the matching relations of the knowledge graph.
   */
  search(query: string, limit = 8): { kind: 'fact' | 'journal' | 'message' | 'relation'; date?: string; text: string }[] {
    const wanted = new Set(terms(query));
    if (wanted.size === 0) return [];
    const day = (at: number) => new Date(at).toLocaleDateString(navigator.language, { day: 'numeric', month: 'long', year: 'numeric' });
    const relations = knowledgeStore.search(query, 4).map((text) => ({ kind: 'relation' as const, text }));
    const candidates = [
      ...facts.map((f) => ({ kind: 'fact' as const, at: f.createdAt, text: f.text })),
      ...journal.map((j) => ({ kind: 'journal' as const, at: j.at, text: j.summary })),
      ...archive.map((m) => ({ kind: 'message' as const, at: m.at, text: `${m.role === 'user' ? 'User' : 'Iris'}: ${m.content}` })),
    ];
    const found = candidates
      .map((c) => ({ ...c, score: score(c.text, wanted) }))
      .filter((c) => c.score > 0)
      // Best matches first; recent ones first among equals.
      .sort((a, b) => b.score - a.score || b.at - a.at)
      .slice(0, limit)
      .map((c) => ({ kind: c.kind, date: day(c.at), text: c.text.slice(0, 600) }));
    return [...relations, ...found];
  },

  // ------------------------------------------------------------ current conversation

  loadConversation: () => read<StoredConversation | null>('conversation', null),
  saveConversation: (conversation: StoredConversation) => write('conversation', conversation),

  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

/** Live view of the memory for Settings. */
export function useMemory() {
  return useSyncExternalStore(memoryStore.subscribe, () => snapshot);
}
