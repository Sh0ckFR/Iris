import { useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { terms } from '../features/assistant/web';
import type { Briefing, GeoPoint } from '../features/assistant/tools';
import { t } from '../i18n';

/**
 * The knowledge graph: people, places, organisations, projects and topics of the user's life,
 * and how they relate ("Claire —manager de→ vous"). Kept on disk (`<app data>/memory/graph.json`).
 * It is fed at no token cost: the entities come from the conversation summary Iris already
 * writes (same call, see SUMMARY_SYSTEM), and from the tools' results (a city whose weather was
 * asked, a company whose share price was checked…).
 */

export type EntityType = 'person' | 'place' | 'organization' | 'project' | 'topic' | 'event' | 'thing';
export const ENTITY_TYPES: EntityType[] = ['person', 'place', 'organization', 'project', 'topic', 'event', 'thing'];

/** The user: the centre of the graph. */
export const USER_ID = 'user';

export interface GraphEntity {
  id: string;
  name: string;
  type: EntityType;
  mentions: number;
  firstSeen: number;
  lastSeen: number;
  coords?: GeoPoint;
}

export interface GraphRelation {
  id: string;
  from: string;
  to: string;
  /** Short phrase in the conversation's language: "manager de", "habite à", "travaille sur". */
  label: string;
  count: number;
  lastSeen: number;
}

export interface ExtractedGraph {
  entities: { name: string; type: EntityType }[];
  relations: { from: string; to: string; label: string }[];
}

interface GraphFile {
  entities: GraphEntity[];
  relations: GraphRelation[];
}

const MAX_ENTITIES = 400;
const MAX_RELATIONS = 800;
const FILE = 'graph';

let graph: GraphFile = { entities: [], relations: [] };
let snapshot: GraphFile = graph;
let loaded: Promise<void> | null = null;
let saveTimer: number | undefined;
const listeners = new Set<() => void>();

const normalize = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
const entityId = (name: string) => `e:${normalize(name)}`;

/** Names the models use for the user themselves. */
const USER_NAMES = new Set(['user', 'the user', 'utilisateur', "l'utilisateur", 'vous', 'you', 'moi', 'me']);

function changed() {
  snapshot = { entities: graph.entities, relations: graph.relations };
  listeners.forEach((l) => l());
  // Several updates in a row (a summary adds many entities) are written once.
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    invoke('memory_write', { name: FILE, content: JSON.stringify(graph) }).catch((error) =>
      console.warn('[iris:memory] could not save the knowledge graph', error),
    );
  }, 800);
}

/** Keeps the graph small: the least mentioned, least recent entities go first. */
function prune() {
  if (graph.entities.length > MAX_ENTITIES) {
    const keep = new Set(
      [...graph.entities]
        .sort((a, b) => b.mentions - a.mentions || b.lastSeen - a.lastSeen)
        .slice(0, MAX_ENTITIES)
        .map((e) => e.id),
    );
    graph.entities = graph.entities.filter((e) => keep.has(e.id));
  }
  const ids = new Set(graph.entities.map((e) => e.id));
  graph.relations = graph.relations
    .filter((r) => (r.from === USER_ID || ids.has(r.from)) && (r.to === USER_ID || ids.has(r.to)))
    .slice(-MAX_RELATIONS);
}

function upsertEntity(name: string, type: EntityType, now: number, coords?: GeoPoint): string | null {
  const clean = name.trim().replace(/\s+/g, ' ').slice(0, 60);
  if (clean.length < 2) return null;
  if (USER_NAMES.has(normalize(clean))) return USER_ID;
  const id = entityId(clean);
  const existing = graph.entities.find((e) => e.id === id);
  if (existing) {
    graph.entities = graph.entities.map((e) =>
      e.id === id
        ? {
            ...e,
            mentions: e.mentions + 1,
            lastSeen: now,
            // A precise type beats the vague ones given by the tools.
            type: e.type === 'topic' || e.type === 'thing' ? type : e.type,
            coords: e.coords ?? coords,
          }
        : e,
    );
  } else {
    graph.entities = [...graph.entities, { id, name: clean, type, mentions: 1, firstSeen: now, lastSeen: now, coords }];
  }
  return id;
}

function upsertRelation(from: string, to: string, label: string, now: number) {
  const clean = label.trim().replace(/\s+/g, ' ').slice(0, 40);
  if (!clean || from === to) return;
  const id = `${from}|${normalize(clean)}|${to}`;
  const existing = graph.relations.find((r) => r.id === id);
  graph.relations = existing
    ? graph.relations.map((r) => (r.id === id ? { ...r, count: r.count + 1, lastSeen: now } : r))
    : [...graph.relations, { id, from, to, label: clean, count: 1, lastSeen: now }];
}

export const knowledgeStore = {
  load(): Promise<void> {
    loaded ??= (async () => {
      try {
        const raw = await invoke<string | null>('memory_read', { name: FILE });
        const data = raw ? (JSON.parse(raw) as Partial<GraphFile>) : null;
        graph = { entities: data?.entities ?? [], relations: data?.relations ?? [] };
        snapshot = graph;
        listeners.forEach((l) => l());
      } catch (error) {
        console.warn('[iris:memory] could not read the knowledge graph', error);
      }
    })();
    return loaded;
  },

  /** Entities and relations noticed in a conversation (from the summary call). */
  merge(extracted: ExtractedGraph) {
    const now = Date.now();
    const types = new Map<string, EntityType>();
    for (const e of extracted.entities) {
      if (upsertEntity(e.name, e.type, now)) types.set(normalize(e.name), e.type);
    }
    for (const r of extracted.relations) {
      const from = upsertEntity(r.from, types.get(normalize(r.from)) ?? 'thing', now);
      const to = upsertEntity(r.to, types.get(normalize(r.to)) ?? 'thing', now);
      if (from && to) upsertRelation(from, to, r.label, now);
    }
    prune();
    changed();
  },

  /** What a tool looked up becomes part of the user's world (0 tokens). */
  fromBriefing(b: Briefing) {
    const now = Date.now();
    // Relation labels are stored in the interface language of the moment.
    const labels = t().graph.relations;
    const link = (name: string, type: EntityType, label: string, coords?: GeoPoint) => {
      const id = upsertEntity(name, type, now, coords);
      if (id && id !== USER_ID) upsertRelation(USER_ID, id, label, now);
      prune();
      changed();
    };
    switch (b.kind) {
      case 'weather':
        if (b.coords) link(b.coords.name, 'place', labels.weather, b.coords);
        break;
      case 'stock':
        link(b.quote.name, 'organization', labels.followsPrice, undefined);
        break;
      case 'wiki':
        link(b.title, b.coords ? 'place' : 'topic', labels.lookedUp, b.coords);
        break;
      case 'news':
        if (b.place) link(b.place.name, 'place', labels.news, b.place);
        else if (b.heading.includes(':')) link(b.heading.split(':').slice(1).join(':').trim(), 'topic', labels.news);
        break;
    }
  },

  remove(id: string) {
    graph = {
      entities: graph.entities.filter((e) => e.id !== id),
      relations: graph.relations.filter((r) => r.from !== id && r.to !== id),
    };
    changed();
  },

  /** "Oublie Claire": entities named in the request go, with their relations. */
  forget(what: string): string[] {
    const n = normalize(what);
    const removed = graph.entities.filter((e) => {
      const name = normalize(e.name);
      return name.length >= 3 && (n.includes(name) || (n.length >= 3 && name.includes(n)));
    });
    removed.forEach((e) => knowledgeStore.remove(e.id));
    return removed.map((e) => e.name);
  },

  clear() {
    graph = { entities: [], relations: [] };
    changed();
  },

  nameOf(id: string): string {
    if (id === USER_ID) return t().common.you;
    return graph.entities.find((e) => e.id === id)?.name ?? id;
  },

  /** Relations as sentences matching a query, for recall_memory ("Claire → manager de → Vous"). */
  search(query: string, limit = 6): string[] {
    const wanted = new Set(terms(query));
    if (wanted.size === 0) return [];
    const matches = (id: string) => terms(knowledgeStore.nameOf(id)).some((w) => wanted.has(w));
    return graph.relations
      .filter((r) => matches(r.from) || matches(r.to) || terms(r.label).some((w) => wanted.has(w)))
      .sort((a, b) => b.count - a.count || b.lastSeen - a.lastSeen)
      .slice(0, limit)
      .map((r) => `${knowledgeStore.nameOf(r.from)} → ${r.label} → ${knowledgeStore.nameOf(r.to)}`);
  },

  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

/** Live view of the graph for the HUD. */
export function useKnowledge(): GraphFile {
  return useSyncExternalStore(knowledgeStore.subscribe, () => snapshot);
}

/** The model's `graph` field (see SUMMARY_SYSTEM), validated. */
export function parseExtractedGraph(value: unknown): ExtractedGraph {
  const data = (value ?? {}) as { entities?: unknown; relations?: unknown };
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const entities = (Array.isArray(data.entities) ? data.entities : [])
    .map((e) => ({ name: str((e as { name?: unknown })?.name), type: str((e as { type?: unknown })?.type) as EntityType }))
    .filter((e) => e.name.length >= 2)
    .map((e) => ({ ...e, type: ENTITY_TYPES.includes(e.type) ? e.type : ('thing' as const) }))
    .slice(0, 20);
  const relations = (Array.isArray(data.relations) ? data.relations : [])
    .map((r) => {
      const o = (r ?? {}) as { from?: unknown; to?: unknown; label?: unknown };
      return { from: str(o.from), to: str(o.to), label: str(o.label) };
    })
    .filter((r) => r.from && r.to && r.label)
    .slice(0, 20);
  return { entities, relations };
}
