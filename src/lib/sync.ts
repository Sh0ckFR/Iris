import { useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { memoryStore } from './memory';
import { knowledgeStore } from './knowledge';
import { tombstoneStore } from './tombstones';
import { emptyDoc, mergeDocs, sameDoc, type SyncDoc } from './syncMerge';

/**
 * The same Iris on every device: the long-term memory (facts, past conversations' summaries,
 * knowledge graph, deletions) synced through storage the user owns — a WebDAV folder (Nextcloud,
 * kDrive, Koofr…) or a secret GitHub Gist. End-to-end encrypted: AES-256-GCM with a key derived
 * from a passphrase that never leaves the devices (PBKDF2-SHA256, 310,000 rounds); the storage
 * only holds ciphertext. Every 10 minutes, a minute after the memory changes, and at launch.
 * Each device merges (lib/syncMerge.ts) — nothing is lost when two devices changed meanwhile.
 */

export type SyncConfig =
  | { kind: 'webdav'; url: string; user: string; password: string; passphrase: string }
  | { kind: 'gist'; token: string; passphrase: string };

export function parseSyncConfig(raw: string | undefined): SyncConfig | null {
  if (!raw) return null;
  try {
    const c = JSON.parse(raw) as Partial<SyncConfig> & Record<string, string>;
    if (!c.passphrase || c.passphrase.length < 8) return null;
    if (c.kind === 'webdav' && c.url) return { kind: 'webdav', url: c.url.trim(), user: c.user ?? '', password: c.password ?? '', passphrase: c.passphrase };
    if (c.kind === 'gist' && c.token) return { kind: 'gist', token: c.token.trim(), passphrase: c.passphrase };
  } catch {
    // invalid: no sync
  }
  return null;
}

// ---------------------------------------------------------------- encryption

const ITERATIONS = 310_000;

interface Envelope {
  v: 1;
  kdf: 'PBKDF2-SHA256';
  iterations: number;
  salt: string;
  iv: string;
  data: string;
}

const b64 = (bytes: Uint8Array) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Deriving a key takes a moment (on purpose): kept per passphrase and salt. */
const keys = new Map<string, Promise<CryptoKey>>();
let lastSalt: { passphrase: string; salt: Uint8Array<ArrayBuffer> } | null = null;

function deriveKey(passphrase: string, salt: Uint8Array<ArrayBuffer>, iterations = ITERATIONS): Promise<CryptoKey> {
  const id = `${iterations}|${b64(salt)}|${passphrase}`;
  let key = keys.get(id);
  if (!key) {
    key = (async () => {
      const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
      return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    })();
    keys.set(id, key);
  }
  return key;
}

export async function encryptDoc(doc: SyncDoc, passphrase: string): Promise<string> {
  // The salt of the storage's copy is reused (no new derivation at every upload).
  const salt = lastSalt?.passphrase === passphrase ? lastSalt.salt : crypto.getRandomValues(new Uint8Array(16));
  lastSalt = { passphrase, salt };
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(doc))));
  const envelope: Envelope = { v: 1, kdf: 'PBKDF2-SHA256', iterations: ITERATIONS, salt: b64(salt), iv: b64(iv), data: b64(data) };
  return JSON.stringify(envelope);
}

export class WrongPassphrase extends Error {
  constructor() {
    super('the sync passphrase does not match the one used on your other devices');
  }
}

export async function decryptDoc(text: string, passphrase: string): Promise<SyncDoc> {
  const envelope = JSON.parse(text) as Envelope;
  const salt = unb64(envelope.salt);
  const key = await deriveKey(passphrase, salt, envelope.iterations);
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(envelope.iv) }, key, unb64(envelope.data));
  } catch {
    throw new WrongPassphrase();
  }
  lastSalt = { passphrase, salt };
  return { ...emptyDoc(), ...(JSON.parse(new TextDecoder().decode(plain)) as SyncDoc) };
}

// ---------------------------------------------------------------- storages

interface HttpResponse {
  status: number;
  etag: string | null;
  body: string;
}

const http = (method: string, url: string, headers: Record<string, string>, body?: string) =>
  invoke<HttpResponse>('sync_http', { method, url, headers, body: body ?? null });

class Conflict extends Error {}

interface Storage {
  /** The stored copy (null: none yet) and its version, for a conditional write. */
  read(): Promise<{ text: string | null; version?: string }>;
  write(text: string, version?: string): Promise<void>;
}

function check(response: HttpResponse, what: string) {
  if (response.status === 401 || response.status === 403) throw new Error(`${what}: access refused (check the login / token)`);
  if (response.status >= 400) throw new Error(`${what}: HTTP ${response.status}`);
}

function webdav(c: Extract<SyncConfig, { kind: 'webdav' }>): Storage {
  const auth: Record<string, string> = c.user ? { Authorization: `Basic ${b64(new TextEncoder().encode(`${c.user}:${c.password}`))}` } : {};
  return {
    async read() {
      const r = await http('GET', c.url, auth);
      if (r.status === 404) return { text: null };
      check(r, 'WebDAV');
      return { text: r.body, version: r.etag ?? undefined };
    },
    async write(text, version) {
      const headers: Record<string, string> = { ...auth, 'Content-Type': 'application/json' };
      if (version) headers['If-Match'] = version;
      const put = () => http('PUT', c.url, headers, text);
      let r = await put();
      if (r.status === 409 || (r.status === 404 && !version)) {
        // The folder doesn't exist yet.
        await http('MKCOL', c.url.replace(/\/[^/]*$/, '/'), auth);
        r = await put();
      }
      if (r.status === 412) throw new Conflict();
      check(r, 'WebDAV');
    },
  };
}

const GIST_FILE = 'iris-memory.sync';
const GIST_KEY = 'iris.sync.gist';

function gist(c: Extract<SyncConfig, { kind: 'gist' }>): Storage {
  const headers = { Authorization: `Bearer ${c.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  const api = 'https://api.github.com';
  const remembered = () => {
    try {
      return localStorage.getItem(GIST_KEY);
    } catch {
      return null;
    }
  };
  const remember = (id: string) => {
    try {
      localStorage.setItem(GIST_KEY, id);
    } catch {
      // found again next time
    }
  };
  /** The user's sync gist (found by its file name: the other devices find the same one). */
  async function find(): Promise<string | null> {
    const known = remembered();
    if (known) return known;
    const r = await http('GET', `${api}/gists?per_page=100`, headers);
    check(r, 'GitHub');
    const list = JSON.parse(r.body) as { id: string; files: Record<string, unknown> }[];
    const found = list.find((g) => GIST_FILE in g.files)?.id ?? null;
    if (found) remember(found);
    return found;
  }
  return {
    async read() {
      const id = await find();
      if (!id) return { text: null };
      const r = await http('GET', `${api}/gists/${id}`, headers);
      if (r.status === 404) {
        localStorage.removeItem(GIST_KEY);
        return { text: null };
      }
      check(r, 'GitHub');
      const file = (JSON.parse(r.body) as { files: Record<string, { content?: string; truncated?: boolean; raw_url?: string }> }).files[GIST_FILE];
      if (!file) return { text: null };
      if (file.truncated && file.raw_url) {
        const raw = await http('GET', file.raw_url, headers);
        check(raw, 'GitHub');
        return { text: raw.body };
      }
      return { text: file.content ?? null };
    },
    async write(text) {
      const id = await find();
      const body = JSON.stringify({ description: 'Iris — encrypted memory sync', public: false, files: { [GIST_FILE]: { content: text } } });
      const r = await http(id ? 'PATCH' : 'POST', id ? `${api}/gists/${id}` : `${api}/gists`, { ...headers, 'Content-Type': 'application/json' }, body);
      check(r, 'GitHub');
      if (!id) remember((JSON.parse(r.body) as { id: string }).id);
    },
  };
}

// ---------------------------------------------------------------- the cycle

export type SyncStatus = { phase: 'off' | 'idle' | 'syncing' | 'ok' | 'error'; lastSyncAt?: number; error?: string };

let status: SyncStatus = { phase: 'off' };
const listeners = new Set<() => void>();
function setStatus(next: SyncStatus) {
  status = next;
  listeners.forEach((l) => l());
}

/** Applying a merge changes the memory: that must not schedule another sync. */
let applying = false;
let running: Promise<void> | null = null;

function localDoc(): SyncDoc {
  const { facts, journal } = memoryStore.syncState();
  const { items, clearedAt } = tombstoneStore.state();
  return { v: 1, facts, journal, graph: knowledgeStore.syncState(), tombstones: items, clearedAt };
}

async function cycle(config: SyncConfig, retry = true): Promise<void> {
  await memoryStore.load();
  const storage = config.kind === 'webdav' ? webdav(config) : gist(config);
  const { text, version } = await storage.read();
  const remote = text ? await decryptDoc(text, config.passphrase) : null;
  const local = localDoc();
  const merged = remote ? mergeDocs(local, remote) : mergeDocs(local, emptyDoc());
  if (!sameDoc(merged, local)) {
    applying = true;
    try {
      tombstoneStore.apply({ items: merged.tombstones, clearedAt: merged.clearedAt });
      memoryStore.applySync({ facts: merged.facts, journal: merged.journal }, merged.clearedAt);
      knowledgeStore.applySync(merged.graph);
    } finally {
      applying = false;
    }
    console.warn(`[iris:sync] memory updated from the other devices (${merged.facts.length} facts, ${merged.journal.length} conversations)`);
  }
  if (!remote || !sameDoc(merged, remote)) {
    try {
      await storage.write(await encryptDoc(merged, config.passphrase), version);
    } catch (error) {
      // Another device wrote in between: start over from its copy.
      if (error instanceof Conflict && retry) return cycle(config, false);
      throw error;
    }
  }
}

export const syncService = {
  /** One sync now (a second call while one runs waits for it). */
  run(config: SyncConfig | null): Promise<void> {
    if (!config) {
      setStatus({ phase: 'off' });
      return Promise.resolve();
    }
    running ??= (async () => {
      setStatus({ ...status, phase: 'syncing', error: undefined });
      try {
        await cycle(config);
        setStatus({ phase: 'ok', lastSyncAt: Date.now() });
      } catch (error) {
        console.warn('[iris:sync] failed', error);
        setStatus({ ...status, phase: 'error', error: error instanceof Error ? error.message : String(error) });
      } finally {
        running = null;
      }
    })();
    return running;
  },

  /**
   * Keeps the memory in sync while `config()` gives a configuration: at launch, every 10
   * minutes, a minute after the memory changes, and when the app comes back to the screen.
   */
  start(config: () => SyncConfig | null): () => void {
    const run = () => void syncService.run(config());
    let soon: number | undefined;
    const later = () => {
      if (applying || !config()) return;
      window.clearTimeout(soon);
      soon = window.setTimeout(run, 60_000);
    };
    const first = window.setTimeout(run, 15_000);
    const every = window.setInterval(run, 10 * 60_000);
    const offMemory = memoryStore.subscribe(later);
    const offGraph = knowledgeStore.subscribe(later);
    const onVisible = () => document.visibilityState === 'visible' && config() && run();
    document.addEventListener('visibilitychange', onVisible);
    setStatus(config() ? { ...status, phase: status.phase === 'off' ? 'idle' : status.phase } : { phase: 'off' });
    return () => {
      window.clearTimeout(first);
      window.clearTimeout(soon);
      window.clearInterval(every);
      offMemory();
      offGraph();
      document.removeEventListener('visibilitychange', onVisible);
    };
  },

  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

export function useSyncStatus(): SyncStatus {
  return useSyncExternalStore(syncService.subscribe, () => status);
}
