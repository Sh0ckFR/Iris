// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const { costStore, defaultPrice, formatMoneyBoth, textCost } = await import('./costs');

describe('prices and costs', () => {
  it('knows the families of models', () => {
    expect(defaultPrice('gpt-5.1-mini')?.input).toBe(0.25);
    expect(defaultPrice('gpt-4o-mini')?.input).toBe(0.15);
    expect(defaultPrice('claude-haiku-4-5-20251001')?.output).toBe(5);
    expect(defaultPrice('gemini-3.8-flash')?.cached).toBe(0.03);
    expect(defaultPrice('unknown-model')).toBeNull();
  });

  it('bills cached tokens at the cached rate, and counts the saving', () => {
    const price = { input: 1, cached: 0.1, output: 5 };
    const { usd, savedCacheUsd } = textCost(price, 10_000, 8_000, 500);
    expect(usd).toBeCloseTo((2_000 * 1 + 8_000 * 0.1 + 500 * 5) / 1e6);
    expect(savedCacheUsd).toBeCloseTo((8_000 * 0.9) / 1e6);
  });

  it('adds requests to the day, with the tools saving', () => {
    costStore.recordText('Gemini · gemini-3.8-flash', 20_000, 0, 1_000, 4_000);
    const today = costStore.summary().today!;
    expect(today.usd).toBeCloseTo((20_000 * 0.3 + 1_000 * 2.5) / 1e6);
    expect(today.savedToolsUsd).toBeCloseTo((4_000 * 0.3) / 1e6);
    expect(today.byModel['gemini-3.8-flash']).toBeGreaterThan(0);
  });

  it('shows euros with the US dollars in brackets', () => {
    expect(formatMoneyBoth(0.0452, 0.86, 'fr-FR').replace(/\s/g, ' ')).toBe('0,039 € (0,045 USD)');
    expect(formatMoneyBoth(0.02, null, 'fr-FR').replace(/\s/g, ' ')).toBe('0,020 USD');
  });
});
