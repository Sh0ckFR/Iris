import { useEffect, useRef, useState } from 'react';
import { describeWeather, fetchForecast, fetchQuote, fetchQuoteForSymbol, fetchWeather, type GeoPoint, type StockQuote } from '../../assistant/tools';
import type { WidgetItem } from '../../assistant/widgetTools';
import { t, uiLanguage, useT } from '../../../i18n';

/**
 * Live data without the AI: quotes and weather shown on screen refresh themselves from the same
 * free sources as the tools (Yahoo Finance, Open-Meteo). Quotes every minute, weather every
 * 10 minutes; nothing is fetched while the window is hidden.
 */

export const QUOTE_EVERY_MS = 60_000;
export const WEATHER_EVERY_MS = 10 * 60_000;

const lang = () => uiLanguage();

/**
 * Runs `refresh` every `everyMs` while the page is visible (and at once unless the data is fresh),
 * and returns the time of the last success.
 */
function usePolling(refresh: () => Promise<boolean>, everyMs: number, enabled: boolean, key: string, immediate = true): number | null {
  const [updatedAt, setUpdatedAt] = useState<number | null>(immediate ? null : Date.now());
  const run = useRef(refresh);
  run.current = refresh;

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let last = immediate ? 0 : Date.now();
    const tick = async (force = false) => {
      if (!force && (document.hidden || Date.now() - last < everyMs)) return;
      last = Date.now();
      try {
        if ((await run.current()) && alive) setUpdatedAt(Date.now());
      } catch (error) {
        console.warn('[iris:live] refresh failed', error);
      }
    };
    if (immediate) void tick(true);
    // Checked often so a hidden window catches up as soon as it is shown again.
    const timer = window.setInterval(() => void tick(), Math.min(everyMs, 15_000));
    const onVisible = () => !document.hidden && void tick();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, everyMs, key, immediate]);

  return updatedAt;
}

/** Widget items marked `live`, with their current values merged in. */
export function useLiveItems(items: WidgetItem[]): { items: WidgetItem[]; updatedAt: number | null; live: boolean } {
  const [patches, setPatches] = useState<Record<number, Partial<WidgetItem>>>({});
  // What each item resolved to the first time (a Yahoo symbol, the city's coordinates).
  const resolved = useRef<Record<number, { symbol?: string; coords?: GeoPoint }>>({});
  const live = items.some((i) => i.live);
  const key = items.map((i) => `${i.live ?? ''}:${i.query ?? i.label}`).join('|');
  const hasWeather = items.some((i) => i.live === 'weather');
  // Other items (a revised widget): start over.
  useEffect(() => {
    resolved.current = {};
    setPatches({});
  }, [key]);

  const refresh = async () => {
    const next: Record<number, Partial<WidgetItem>> = {};
    await Promise.all(
      items.map(async (item, index) => {
        const query = item.query ?? item.label;
        const known = (resolved.current[index] ??= {});
        try {
          if (item.live === 'quote') {
            const q: StockQuote = known.symbol ? await fetchQuoteForSymbol(known.symbol) : await fetchQuote(query, lang());
            known.symbol = q.symbol;
            next[index] = { value: q.price, unit: q.currency || item.unit, change: q.changePercent ?? undefined };
          } else if (item.live === 'weather') {
            const w = known.coords ? await fetchForecast(known.coords.lat, known.coords.lon) : await fetchWeather(query, lang());
            if ('coords' in w) known.coords = w.coords as GeoPoint;
            const { label } = describeWeather(w.current.code, lang());
            next[index] = {
              value: w.current.temperature,
              unit: '°C',
              detail: `${label} · ${t().briefing.feelsLike.toLowerCase()} ${w.current.feelsLike}° · ${w.current.wind} km/h`,
            };
          }
        } catch (error) {
          console.warn(`[iris:live] ${query}`, error);
        }
      }),
    );
    setPatches((prev) => ({ ...prev, ...next }));
    return Object.keys(next).length > 0;
  };

  // Weather only matters every 10 minutes; a widget with quotes refreshes every minute.
  const everyMs = items.some((i) => i.live === 'quote') ? QUOTE_EVERY_MS : hasWeather ? WEATHER_EVERY_MS : QUOTE_EVERY_MS;
  const updatedAt = usePolling(refresh, everyMs, live, key);
  return { items: items.map((item, i) => (patches[i] ? { ...item, ...patches[i] } : item)), updatedAt, live };
}

/** A quote card that follows the market (same symbol, every minute). */
export function useLiveQuote(initial: StockQuote): { quote: StockQuote; updatedAt: number | null } {
  const [quote, setQuote] = useState(initial);
  useEffect(() => setQuote(initial), [initial]);
  const updatedAt = usePolling(
    async () => {
      setQuote(await fetchQuoteForSymbol(initial.symbol));
      return true;
    },
    QUOTE_EVERY_MS,
    true,
    initial.symbol,
    false, // the card was just fetched
  );
  return { quote, updatedAt };
}

/** A weather card that stays current (same place, every 10 minutes). */
export function useLiveForecast<T extends { current: unknown; days: unknown }>(initial: T, coords?: GeoPoint): { data: T; updatedAt: number | null } {
  const [data, setData] = useState(initial);
  useEffect(() => setData(initial), [initial]);
  const updatedAt = usePolling(
    async () => {
      if (!coords) return false;
      const fresh = await fetchForecast(coords.lat, coords.lon);
      setData((d) => ({ ...d, ...fresh }));
      return true;
    },
    WEATHER_EVERY_MS,
    !!coords,
    coords ? `${coords.lat},${coords.lon}` : '',
    false,
  );
  return { data, updatedAt };
}

/** "● EN DIRECT · il y a 20 s": shows that a card refreshes by itself. */
export function LiveBadge({ updatedAt }: { updatedAt: number | null }) {
  const [, setNow] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setNow((n) => n + 1), 10_000);
    return () => window.clearInterval(timer);
  }, []);
  const t = useT().live;
  const ago = updatedAt ? Math.max(0, Math.round((Date.now() - updatedAt) / 1000)) : null;
  const when = ago === null ? t.connecting : ago < 60 ? t.secondsAgo(ago) : t.minutesAgo(Math.round(ago / 60));
  return (
    <span className="wg-live" title={t.title}>
      <i />
      {t.badge} · {when}
    </span>
  );
}
