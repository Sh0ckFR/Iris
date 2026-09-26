import { describe, expect, it } from 'vitest';
import { LANGUAGES, DEFAULT_UI_LANGUAGE } from './index';
import { en } from './en';
import { plural } from './plural';

type Tree = { [key: string]: unknown };

/** Every leaf of a messages tree: "settings.voice.title" → value. */
function leaves(tree: Tree, prefix = ''): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) leaves(value as Tree, path).forEach((v, k) => out.set(k, v));
    else out.set(path, value);
  }
  return out;
}

const reference = leaves(en);

describe('interface languages', () => {
  it('English is the default', () => {
    expect(DEFAULT_UI_LANGUAGE).toBe('en');
  });

  for (const [code, { messages }] of Object.entries(LANGUAGES)) {
    it(`${code} has exactly the English keys, all filled`, () => {
      const own = leaves(messages as unknown as Tree);
      expect([...own.keys()].sort()).toEqual([...reference.keys()].sort());
      for (const [path, value] of own) {
        const expected = reference.get(path);
        expect(typeof value, path).toBe(typeof expected);
        if (typeof value === 'string') expect(value.trim(), path).not.toBe('');
        if (Array.isArray(value)) expect(value.length, path).toBe((expected as unknown[]).length);
        if (typeof value === 'function') {
          const text = (value as (...args: unknown[]) => unknown)(3, 5);
          expect(typeof text, path).toBe('string');
          expect((text as string).trim(), path).not.toBe('');
        }
      }
    });
  }
});

describe('plural', () => {
  it('follows each language’s rules', () => {
    const ru = plural('ru');
    const forms = { one: '# место', few: '# места', many: '# мест', other: '# места' };
    expect(ru(1, forms)).toBe('1 место');
    expect(ru(3, forms)).toBe('3 места');
    expect(ru(5, forms)).toBe('5 мест');
    expect(plural('en')(1, { one: '# place', other: '# places' })).toBe('1 place');
    expect(plural('en')(2, { one: '# place', other: '# places' })).toBe('2 places');
  });
});
