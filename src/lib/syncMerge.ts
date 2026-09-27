import type { JournalEntry, MemoryFact } from './memory';
import type { GraphEntity, GraphFile, GraphRelation } from './knowledge';
import type { Tombstone } from './tombstones';

/**
 * The memory shared between devices (lib/sync.ts) and how two copies become one. Every device
 * may have added and removed things since the last sync: the result is the union of both, minus
 * what either deleted (tombstones) and everything older than the last "forget everything".
 */

export interface SyncDoc {
  v: 1;
  facts: MemoryFact[];
  journal: JournalEntry[];
  graph: GraphFile;
  tombstones: Tombstone[];
  clearedAt: number;
}

const MAX_JOURNAL = 300;
const MAX_ENTITIES = 400;
const MAX_RELATIONS = 800;

export const emptyDoc = (): SyncDoc => ({ v: 1, facts: [], journal: [], graph: { entities: [], relations: [] }, tombstones: [], clearedAt: 0 });

const normalize = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

function unionBy<T>(a: T[], b: T[], key: (x: T) => string, pick: (x: T, y: T) => T): T[] {
  const map = new Map<string, T>();
  for (const x of [...a, ...b]) {
    const k = key(x);
    const existing = map.get(k);
    map.set(k, existing ? pick(existing, x) : x);
  }
  return [...map.values()];
}

export function mergeDocs(a: SyncDoc, b: SyncDoc): SyncDoc {
  const clearedAt = Math.max(a.clearedAt, b.clearedAt);
  const tombstones = unionBy(a.tombstones, b.tombstones, (t) => t.id, (x, y) => (x.at >= y.at ? x : y));
  const deletedAt = new Map(tombstones.map((t) => [t.id, t.at]));
  /** Gone: deleted after it was last seen, or older than "forget everything". */
  const gone = (id: string, seenAt: number) => seenAt < clearedAt || (deletedAt.get(id) ?? -1) >= seenAt;

  // Facts: by id; the same sentence added on two devices is kept once (the older one).
  const byId = unionBy(a.facts, b.facts, (f) => f.id, (x) => x).filter((f) => !gone(f.id, f.createdAt));
  const facts = unionBy(
    [...byId].sort((x, y) => x.createdAt - y.createdAt),
    [],
    (f) => normalize(f.text),
    (x) => x,
  ).sort((x, y) => x.createdAt - y.createdAt);

  const journal = unionBy(a.journal, b.journal, (j) => `${j.at}`, (x) => x)
    .filter((j) => j.at >= clearedAt)
    .sort((x, y) => x.at - y.at)
    .slice(-MAX_JOURNAL);

  let entities = unionBy<GraphEntity>(a.graph.entities, b.graph.entities, (e) => e.id, (x, y) => ({
    ...x,
    mentions: Math.max(x.mentions, y.mentions),
    firstSeen: Math.min(x.firstSeen, y.firstSeen),
    lastSeen: Math.max(x.lastSeen, y.lastSeen),
    // A precise type beats the vague ones.
    type: x.type === 'topic' || x.type === 'thing' ? y.type : x.type,
    coords: x.coords ?? y.coords,
  })).filter((e) => !gone(e.id, e.lastSeen));
  if (entities.length > MAX_ENTITIES) {
    entities = [...entities].sort((x, y) => y.mentions - x.mentions || y.lastSeen - x.lastSeen).slice(0, MAX_ENTITIES);
  }
  const ids = new Set(entities.map((e) => e.id));
  const relations = unionBy<GraphRelation>(a.graph.relations, b.graph.relations, (r) => r.id, (x, y) => ({
    ...x,
    count: Math.max(x.count, y.count),
    lastSeen: Math.max(x.lastSeen, y.lastSeen),
  }))
    .filter((r) => !gone(r.id, r.lastSeen) && (r.from === 'user' || ids.has(r.from)) && (r.to === 'user' || ids.has(r.to)))
    .sort((x, y) => x.lastSeen - y.lastSeen)
    .slice(-MAX_RELATIONS);

  return { v: 1, facts, journal, graph: { entities: entities.sort((x, y) => x.firstSeen - y.firstSeen), relations }, tombstones, clearedAt };
}

/** Same content, whatever the order (to skip needless uploads and rewrites). */
export function sameDoc(a: SyncDoc, b: SyncDoc): boolean {
  const canonical = (d: SyncDoc) =>
    JSON.stringify([
      [...d.facts].sort((x, y) => x.id.localeCompare(y.id)),
      [...d.journal].sort((x, y) => x.at - y.at),
      [...d.graph.entities].sort((x, y) => x.id.localeCompare(y.id)),
      [...d.graph.relations].sort((x, y) => x.id.localeCompare(y.id)),
      [...d.tombstones].sort((x, y) => x.id.localeCompare(y.id)),
      d.clearedAt,
    ]);
  return canonical(a) === canonical(b);
}
