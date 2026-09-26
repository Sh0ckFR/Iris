import { describe, expect, it, vi } from 'vitest';

// The watcher's network and disk access are not needed for the conditions.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }));

const { isMet, describeAlert, firedLine } = await import('./alerts');

const quote = (value: number) => ({ value, unit: 'USD', name: 'Bitcoin USD' });
const weather = (code: number, value = 18, wind = 10) => ({ value, unit: '°C', name: 'Lyon', code, wind, label: 'Pluie' });

describe('alert conditions', () => {
  it('above / below a price', () => {
    expect(isMet({ op: 'below', threshold: 80000 }, quote(79850))).toBe(true);
    expect(isMet({ op: 'below', threshold: 80000 }, quote(84000))).toBe(false);
    expect(isMet({ op: 'above', threshold: 8200 }, quote(8201))).toBe(true);
  });

  it('a move of n % from when it was set', () => {
    expect(isMet({ op: 'move', threshold: 3, base: 100 }, quote(103.1))).toBe(true);
    expect(isMet({ op: 'move', threshold: 3, base: 100 }, quote(96.9))).toBe(true);
    expect(isMet({ op: 'move', threshold: 3, base: 100 }, quote(102))).toBe(false);
    expect(isMet({ op: 'move', threshold: 3 }, quote(200))).toBe(false); // no base: never
  });

  it('weather: rain, temperature, wind', () => {
    expect(isMet({ op: 'rain' }, weather(61))).toBe(true); // rain
    expect(isMet({ op: 'rain' }, weather(95))).toBe(true); // storm
    expect(isMet({ op: 'rain' }, weather(2))).toBe(false); // partly cloudy
    expect(isMet({ op: 'temp_above', threshold: 30 }, weather(0, 31))).toBe(true);
    expect(isMet({ op: 'temp_below', threshold: 0 }, weather(0, 2))).toBe(false);
    expect(isMet({ op: 'wind_above', threshold: 50 }, weather(0, 10, 60))).toBe(true);
  });
});

describe('what Iris says', () => {
  const alert = { id: 'a', source: 'quote' as const, query: 'bitcoin', name: 'Bitcoin', unit: 'USD', op: 'below' as const, threshold: 80000, createdAt: 0 };

  it('describes an alert', () => {
    expect(describeAlert(alert, true).replace(/\s/g, ' ')).toBe('Bitcoin sous 80 000 USD');
    expect(describeAlert(alert, false)).toBe('Bitcoin below 80,000 USD');
  });

  it('announces it with the honorific', () => {
    const line = firedLine(alert, quote(79850), true, 'Monsieur').replace(/\s/g, ' ');
    expect(line).toBe('Monsieur, alerte : Bitcoin sous 80 000 USD — 79 850 USD en ce moment.');
  });
});
