import { invoke } from '@tauri-apps/api/core';

/**
 * Deletions, remembered so that the memory sync (lib/sync.ts) removes an item on the other
 * devices too instead of bringing it back. Ids: facts `f-…`, graph entities `e:…`, relations
 * `from|label|to`. `clearedAt`: "forget everything" was asked then — anything older is gone on
 * every device. Kept in `<app data>/memory/tombstones.json`.
 */

export interface Tombstone {
  id: string;
  at: number;
}

const FILE = 'tombstones';
/** Old enough that every device has synced since. */
const KEEP_MS = 180 * 86_400_000;

let items: Tombstone[] = [];
let clearedAt = 0;
let loaded: Promise<void> | null = null;

function save() {
  invoke('memory_write', { name: FILE, content: JSON.stringify({ items, clearedAt }) }).catch((error) =>
    console.warn('[iris:memory] could not save the deletions', error),
  );
}

export const tombstoneStore = {
  load(): Promise<void> {
    loaded ??= (async () => {
      try {
        const raw = await invoke<string | null>('memory_read', { name: FILE });
        const data = raw ? (JSON.parse(raw) as { items?: Tombstone[]; clearedAt?: number }) : {};
        items = data.items ?? [];
        clearedAt = data.clearedAt ?? 0;
      } catch (error) {
        console.warn('[iris:memory] could not read the deletions', error);
      }
    })();
    return loaded;
  },

  add(ids: string[]) {
    if (!ids.length) return;
    const at = Date.now();
    items = [...items.filter((t) => !ids.includes(t.id) && at - t.at < KEEP_MS), ...ids.map((id) => ({ id, at }))];
    save();
  },

  /** Everything forgotten now. */
  clearAll() {
    items = [];
    clearedAt = Date.now();
    save();
  },

  state: () => ({ items, clearedAt }),

  apply(next: { items: Tombstone[]; clearedAt: number }) {
    items = next.items.filter((t) => Date.now() - t.at < KEEP_MS);
    clearedAt = next.clearedAt;
    save();
  },
};
