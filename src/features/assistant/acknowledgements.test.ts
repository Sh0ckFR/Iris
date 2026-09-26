import { describe, expect, it } from 'vitest';
import { acknowledgement, allAcknowledgements } from './acknowledgements';

describe('spoken acknowledgements', () => {
  it('fit the tool at work, in the right language, with the honorific', () => {
    expect(['Je regarde ça, monsieur.', 'Je vérifie, monsieur.']).toContain(acknowledgement('search_web', 'fr', 'Monsieur'));
    expect(['Preparing it now, sir.', 'Coming right up, sir.']).toContain(acknowledgement('create_visual', 'en', 'Monsieur'));
    expect(['Un instant.', 'Tout de suite.']).toContain(acknowledgement(null, 'fr', ''));
  });

  it('are a small fixed set (synthesized once, replayed from memory)', () => {
    const all = allAcknowledgements('fr', 'Monsieur');
    expect(all.length).toBeLessThanOrEqual(8);
    expect(all.every((p) => p.endsWith(', monsieur.'))).toBe(true);
  });
});
