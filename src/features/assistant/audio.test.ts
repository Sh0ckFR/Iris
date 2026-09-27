import { describe, expect, it } from 'vitest';
import { splitSentences } from './audio';
import { pcm16ToFloat } from './tts';

describe('speech output', () => {
  it('splits complete sentences, keeping short fragments together', () => {
    expect(splitSentences('Bonjour Monsieur. Il fait beau à Paris aujourd’hui. Et dem')).toEqual([
      ['Bonjour Monsieur.', 'Il fait beau à Paris aujourd’hui.'],
      'Et dem',
    ]);
    // "Oui." alone is too short: it goes with what follows.
    expect(splitSentences('Oui. Je vous écoute attentivement. ')).toEqual([['Oui. Je vous écoute attentivement.'], '']);
  });

  it('starts with the first clause of a long first sentence', () => {
    const text = 'Bien sûr, voici les trois vols les moins chers pour Lisbonne la semaine prochaine';
    expect(splitSentences(text)).toEqual([[], text]);
    const [first, rest] = splitSentences(text, { firstClause: true });
    expect(first).toEqual([]); // "Bien sûr," alone is too short to be worth it
    const longer = 'Je regarde les horaires de train pour Lyon, puis je compare avec les vols du matin';
    const [clause, after] = splitSentences(longer, { firstClause: true });
    expect(clause).toEqual(['Je regarde les horaires de train pour Lyon,']);
    expect(after).toBe('puis je compare avec les vols du matin');
    expect(rest).toBe(text);
    // Numbers are not clauses.
    expect(splitSentences('Le taux est de 3,5 % cette année selon la banque centrale européenne', { firstClause: true })[0]).toEqual([]);
  });

  it('decodes streamed 16-bit PCM across odd chunk boundaries', () => {
    // 0x4000 = 16384 → 0.5 ; 0xC000 = -16384 → -0.5, split in the middle of the second sample.
    const a = pcm16ToFloat(Uint8Array.of(0x00, 0x40, 0x00), null);
    expect(Array.from(a.samples)).toEqual([0.5]);
    expect(a.carry).toBe(0x00);
    const b = pcm16ToFloat(Uint8Array.of(0xc0), a.carry);
    expect(Array.from(b.samples)).toEqual([-0.5]);
    expect(b.carry).toBeNull();
  });
});
