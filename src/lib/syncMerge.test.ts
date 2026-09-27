import { describe, expect, it } from 'vitest';
import { emptyDoc, mergeDocs, sameDoc, type SyncDoc } from './syncMerge';

const fact = (id: string, text: string, createdAt: number) => ({ id, text, createdAt, source: 'user' as const });
const entity = (id: string, name: string, lastSeen: number, mentions = 1) => ({ id, name, type: 'person' as const, mentions, firstSeen: 1, lastSeen });
const doc = (patch: Partial<SyncDoc>): SyncDoc => ({ ...emptyDoc(), ...patch });

describe('memory sync merge', () => {
  it('keeps what each device added, once', () => {
    const pc = doc({ facts: [fact('f-1', 'Mon manager est Claire.', 10)], journal: [{ at: 5, summary: 'A' }] });
    const phone = doc({ facts: [fact('f-2', 'Je suis végétarien.', 20), fact('f-3', 'Mon  manager est Claire.', 30)], journal: [{ at: 5, summary: 'A' }, { at: 9, summary: 'B' }] });
    const merged = mergeDocs(pc, phone);
    expect(merged.facts.map((f) => f.id)).toEqual(['f-1', 'f-2']); // the same sentence twice: the older one stays
    expect(merged.journal.map((j) => j.summary)).toEqual(['A', 'B']);
    expect(sameDoc(merged, mergeDocs(phone, pc))).toBe(true);
  });

  it('propagates deletions, but not over something newer', () => {
    const pc = doc({ facts: [fact('f-1', 'Adresse : 3 rue X', 10)], graph: { entities: [entity('e:claire', 'Claire', 50)], relations: [] } });
    const phone = doc({ tombstones: [{ id: 'f-1', at: 40 }, { id: 'e:claire', at: 40 }] });
    const merged = mergeDocs(pc, phone);
    expect(merged.facts).toEqual([]);
    // Claire was mentioned again (at 50) after being forgotten (at 40): she comes back.
    expect(merged.graph.entities.map((e) => e.id)).toEqual(['e:claire']);
  });

  it('"forget everything" wins over everything older, on every device', () => {
    const pc = doc({ facts: [fact('f-1', 'Ancien', 10), fact('f-9', 'Nouveau', 200)], journal: [{ at: 10, summary: 'old' }] });
    const phone = doc({ clearedAt: 100 });
    const merged = mergeDocs(pc, phone);
    expect(merged.facts.map((f) => f.text)).toEqual(['Nouveau']);
    expect(merged.journal).toEqual([]);
    expect(merged.clearedAt).toBe(100);
  });

  it('merges graph counters and drops relations to removed entities', () => {
    const pc = doc({ graph: { entities: [entity('e:lyon', 'Lyon', 10, 3)], relations: [{ id: 'user|habite a|e:lyon', from: 'user', to: 'e:lyon', label: 'habite à', count: 2, lastSeen: 10 }] } });
    const phone = doc({ graph: { entities: [entity('e:lyon', 'Lyon', 30, 1)], relations: [{ id: 'e:x|connait|e:lyon', from: 'e:x', to: 'e:lyon', label: 'connaît', count: 1, lastSeen: 30 }] } });
    const merged = mergeDocs(pc, phone);
    expect(merged.graph.entities[0]).toMatchObject({ mentions: 3, lastSeen: 30 });
    expect(merged.graph.relations.map((r) => r.id)).toEqual(['user|habite a|e:lyon']);
  });
});
