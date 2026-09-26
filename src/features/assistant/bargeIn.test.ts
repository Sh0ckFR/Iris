import { describe, expect, it } from 'vitest';
import { isEcho, isInterruption, isNoise } from './bargeIn';

const said = ['La météo à Lyon sera ensoleillée demain, avec 24 degrés.', "Je vous suggère d'emporter une veste pour le soir."];

describe('cutting Iris off', () => {
  it('the user talking over her is an interruption, with or without her name', () => {
    expect(isInterruption('Attends, et à Paris ?', said)).toBe(true);
    expect(isInterruption('Non, je voulais dire la semaine prochaine', said)).toBe(true);
    expect(isInterruption('Iris, stop', said)).toBe(true);
  });

  it('her own voice coming back through the speakers is not', () => {
    expect(isEcho('la météo à Lyon sera ensoleillée demain', said)).toBe(true);
    expect(isInterruption("d'emporter une veste pour le soir", said)).toBe(false);
  });

  it('nor noise that Whisper turned into words', () => {
    expect(isNoise('Merci.')).toBe(true);
    expect(isNoise('Sous-titres réalisés par la communauté d’Amara.org')).toBe(true);
    expect(isNoise('...')).toBe(true);
    expect(isNoise('Merci, et pour demain ?')).toBe(false);
  });
});
