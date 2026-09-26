import { describe, expect, it } from 'vitest';
import { matchLocalCommand, parseDuration } from './localCommands';

describe('answered locally (0 token)', () => {
  it.each([
    ['Iris, quelle heure est-il ?', { kind: 'time' }],
    ['On est quel jour ?', { kind: 'date' }],
    ['Iris, mets un minuteur de 10 minutes', { kind: 'timer', seconds: 600 }],
    ['Iris, stop', { kind: 'stop_talking' }],
    ["Iris, arrête d'écouter", { kind: 'stop_listening' }],
    ['Iris, affiche mon écran du matin', { kind: 'dashboard', action: 'show', name: 'matin' }],
    ['Affiche mon tableau de bord', { kind: 'dashboard', action: 'show', name: undefined }],
    ['Ferme le tableau de bord', { kind: 'dashboard', action: 'hide' }],
    ['Iris, montre-toi', { kind: 'window', target: 'main', action: 'show' }],
  ])('%s', (text, expected) => {
    expect(matchLocalCommand(text)).toMatchObject(expected);
  });

  it('leaves real questions to the AI', () => {
    expect(matchLocalCommand('Quelle est la météo à Lyon ?')).toBeNull();
    expect(matchLocalCommand('Ouvre le fichier du rapport')).toBeNull();
  });

  it('reads durations', () => {
    expect(parseDuration('une heure et demie')).toBe(5400);
    expect(parseDuration('1h30')).toBe(5400);
    expect(parseDuration('90 secondes')).toBe(90);
    expect(parseDuration('demain')).toBeNull();
  });
});
