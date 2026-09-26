import { describe, expect, it } from 'vitest';
import { isAddressedToIris, stripAddress } from './wakeWord';

describe('wake word', () => {
  it('hears the name at the start or the end of a sentence', () => {
    for (const text of [
      'Iris, ouvre la calculatrice.',
      'Iris ?',
      'Hey Iris, what time is it?',
      'Dis Iris, quelle heure est-il ?',
      'Ouvre la calculatrice, Iris.',
      "Ouvre la calculatrice, Iris, s'il te plaît.",
      'Open the calculator, Iris, please.',
      'I.R.I.S., stop',
    ]) {
      expect(isAddressedToIris(text), text).toBe(true);
    }
  });

  it('tolerates how speech recognition spells it', () => {
    for (const text of ['Irisse, quelle heure est-il ?', 'Hiris, stop', 'Yris, stop', 'Mets un minuteur, Iriss.']) {
      expect(isAddressedToIris(text), text).toBe(true);
    }
  });

  it('ignores sentences not addressed to her', () => {
    for (const text of [
      'On se voit demain ?',
      "Je lui ai parlé d'Iris hier soir au téléphone.",
      'An Irish coffee, please.',
    ]) {
      expect(isAddressedToIris(text), text).toBe(false);
    }
  });

  it('strips the way she is addressed', () => {
    expect(stripAddress('Iris, ouvre la calculatrice.')).toBe('ouvre la calculatrice.');
    expect(stripAddress('Hey Iris, what time is it?')).toBe('what time is it?');
    expect(stripAddress("Ouvre la calculatrice, Iris, s'il te plaît.")).toBe('Ouvre la calculatrice');
  });
});
