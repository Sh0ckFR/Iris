import { useSyncExternalStore } from 'react';
import { fetchQuoteForSymbol } from '../features/assistant/tools';

/**
 * What Iris costs, in money: each request is priced from its tokens and its model, added to a
 * ledger kept per day (this computer only), with what the prompt cache and the dynamic tool
 * selection saved. Prices are the providers' public list prices per million tokens (USD),
 * approximate and editable in Settings; the euro rate comes from Yahoo Finance once a day.
 */

/** USD per million tokens. */
export interface Price {
  input: number;
  cached: number;
  output: number;
}

/** List prices by model family (first match). Approximate — Settings can override any model. */
const DEFAULT_PRICES: [RegExp, Price][] = [
  [/gpt-[\d.]+-nano/, { input: 0.05, cached: 0.005, output: 0.4 }],
  [/gpt-4o-mini/, { input: 0.15, cached: 0.075, output: 0.6 }],
  [/gpt-4\.1-mini/, { input: 0.4, cached: 0.1, output: 1.6 }],
  [/gpt-[\d.]+-mini|o\d-mini/, { input: 0.25, cached: 0.025, output: 2 }],
  [/gpt-4o|gpt-4\.1/, { input: 2.5, cached: 1.25, output: 10 }],
  [/gpt-|^o\d/, { input: 1.25, cached: 0.125, output: 10 }],
  [/haiku/, { input: 1, cached: 0.1, output: 5 }],
  [/sonnet/, { input: 3, cached: 0.3, output: 15 }],
  [/opus/, { input: 5, cached: 0.5, output: 25 }],
  [/gemini.*flash-lite/, { input: 0.1, cached: 0.01, output: 0.4 }],
  [/gemini.*flash/, { input: 0.3, cached: 0.03, output: 2.5 }],
  [/gemini.*pro/, { input: 1.25, cached: 0.125, output: 10 }],
];

/** OpenAI Realtime: text and audio tokens (USD per million). */
const REALTIME = {
  mini: { text: { input: 0.6, cached: 0.06, output: 2.4 }, audioIn: 10, audioOut: 20 },
  full: { text: { input: 4, cached: 0.4, output: 16 }, audioIn: 32, audioOut: 64 },
};
/** OpenAI text-to-speech (gpt-4o-mini-tts), USD per million characters (≈ $0.015 a minute). */
const TTS_PER_M_CHARS = 15;

export function defaultPrice(model: string): Price | null {
  return DEFAULT_PRICES.find(([pattern]) => pattern.test(model))?.[1] ?? null;
}

// ---------------------------------------------------------------- ledger

export interface DayCost {
  day: string;
  usd: number;
  /** Paid at the cached rate instead of the full one. */
  savedCacheUsd: number;
  /** Tool definitions not sent thanks to the dynamic selection. */
  savedToolsUsd: number;
  byModel: Record<string, number>;
}

const KEY = 'iris.costs.v1';
const RATE_KEY = 'iris.eurusd.v1';
const DAYS_KEPT = 62;

const today = () => new Date().toLocaleDateString('sv'); // YYYY-MM-DD, local time

function loadDays(): DayCost[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]') as DayCost[];
  } catch {
    return [];
  }
}

let days = loadDays();
let overrides: Record<string, Price> = {};
let realtimeModel = '';
/** EUR for one USD (null until known). */
let eurPerUsd: number | null = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem(RATE_KEY) ?? 'null') as { day: string; rate: number } | null;
    return saved?.rate ?? null;
  } catch {
    return null;
  }
})();
let snapshot = { days, eurPerUsd };
const listeners = new Set<() => void>();

function changed() {
  snapshot = { days, eurPerUsd };
  try {
    localStorage.setItem(KEY, JSON.stringify(days.slice(-DAYS_KEPT)));
  } catch {
    // not remembered
  }
  listeners.forEach((l) => l());
}

function addToToday(model: string, usd: number, savedCacheUsd = 0, savedToolsUsd = 0) {
  const d = today();
  let entry = days.find((x) => x.day === d);
  if (!entry) {
    entry = { day: d, usd: 0, savedCacheUsd: 0, savedToolsUsd: 0, byModel: {} };
    days = [...days, entry].slice(-DAYS_KEPT);
  }
  entry.usd += usd;
  entry.savedCacheUsd += savedCacheUsd;
  entry.savedToolsUsd += savedToolsUsd;
  entry.byModel[model] = (entry.byModel[model] ?? 0) + usd;
  days = days.map((x) => (x.day === d ? { ...entry! } : x));
  changed();
}

/** The price used for a model: the user's, else the family's list price. */
export function priceFor(model: string): Price | null {
  return overrides[model] ?? defaultPrice(model);
}

/** Cost of a request and what the cache saved, in USD. Pure given the price. */
export function textCost(price: Price, input: number, cached: number, output: number) {
  const fresh = Math.max(0, input - cached);
  return {
    usd: (fresh * price.input + cached * price.cached + output * price.output) / 1e6,
    savedCacheUsd: (cached * (price.input - price.cached)) / 1e6,
  };
}

export const costStore = {
  /** A text model call (label "Gemini · gemini-3.8-flash"); `savedToolTokens`: definitions not sent. */
  recordText(label: string, input: number, cached: number, output: number, savedToolTokens = 0) {
    const model = label.split(' · ').pop() ?? label;
    const price = priceFor(model);
    if (!price) return;
    const { usd, savedCacheUsd } = textCost(price, input, cached, output);
    addToToday(model, usd, savedCacheUsd, (savedToolTokens * price.input) / 1e6);
  },
  recordRealtime(textIn: number, cachedIn: number, textOut: number, audioIn: number, audioOut: number) {
    const p = /mini/.test(realtimeModel) ? REALTIME.mini : REALTIME.full;
    const text = textCost(p.text, Math.max(0, textIn - audioIn), cachedIn, Math.max(0, textOut - audioOut));
    addToToday(realtimeModel || 'realtime', text.usd + (audioIn * p.audioIn + audioOut * p.audioOut) / 1e6, text.savedCacheUsd);
  },
  recordTts(characters: number) {
    addToToday('tts', (characters * TTS_PER_M_CHARS) / 1e6);
  },
  /** Settings: price overrides per model, and the Realtime model in use. */
  configure(prices: Record<string, Price>, realtime: string) {
    overrides = prices;
    realtimeModel = realtime;
  },
  summary: (): CostSummary => summarize(days, eurPerUsd),
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

/** Refreshes the euro rate once a day (Yahoo Finance, free). */
export async function refreshEuroRate(): Promise<void> {
  try {
    const saved = JSON.parse(localStorage.getItem(RATE_KEY) ?? 'null') as { day: string } | null;
    if (saved?.day === today() && eurPerUsd) return;
  } catch {
    // fetch it
  }
  try {
    const q = await fetchQuoteForSymbol('EURUSD=X'); // USD for one EUR
    if (q.price > 0) {
      eurPerUsd = 1 / q.price;
      localStorage.setItem(RATE_KEY, JSON.stringify({ day: today(), rate: eurPerUsd }));
      changed();
    }
  } catch (error) {
    console.warn('[iris:costs] euro rate unavailable', error);
  }
}

export interface CostSummary {
  today: DayCost | null;
  monthUsd: number;
  eurPerUsd: number | null;
}

export function summarize(list: DayCost[], rate: number | null): CostSummary {
  const d = today();
  const month = d.slice(0, 7);
  return {
    today: list.find((x) => x.day === d) ?? null,
    monthUsd: list.filter((x) => x.day.startsWith(month)).reduce((n, x) => n + x.usd, 0),
    eurPerUsd: rate,
  };
}

export function useCosts(): CostSummary {
  const s = useSyncExternalStore(costStore.subscribe, () => snapshot);
  return summarize(s.days, s.eurPerUsd);
}

/** "0,042 €" (or "$0.042" until the euro rate is known). */
export function formatMoney(usd: number, rate: number | null, lang = navigator.language): string {
  const value = rate ? usd * rate : usd;
  const digits = value < 0.1 ? 3 : 2;
  return value.toLocaleString(lang, { style: 'currency', currency: rate ? 'EUR' : 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** "0,042 € (0,045 $US)": euros, with the US dollars billed by the providers in brackets. */
export function formatMoneyBoth(usd: number, rate: number | null, lang = navigator.language): string {
  const dollars = usd.toLocaleString(lang, { style: 'currency', currency: 'USD', currencyDisplay: 'code', minimumFractionDigits: usd < 0.1 ? 3 : 2, maximumFractionDigits: usd < 0.1 ? 3 : 2 });
  return rate ? `${formatMoney(usd, rate, lang)} (${dollars})` : dollars;
}
