import { invoke } from '@tauri-apps/api/core';
import { describeWeather, fetchForecast, fetchQuote, fetchQuoteForSymbol, fetchWeather, type GeoPoint } from './tools';

/**
 * Alerts on live data: "préviens-moi si le bitcoin passe sous 80 000", "s'il pleut à Lyon".
 * Watched on this computer (Yahoo Finance every minute, Open-Meteo every 10 minutes) — no AI call
 * and no token while waiting; Iris only speaks when one fires. Each alert fires once. They are
 * kept on disk (`<app data>/memory/alerts.json`) and survive restarts.
 */

export type AlertSource = 'quote' | 'weather';
export type AlertOp = 'above' | 'below' | 'move' | 'rain' | 'temp_above' | 'temp_below' | 'wind_above';

export interface Alert {
  id: string;
  source: AlertSource;
  /** What is watched: "bitcoin", "EUR USD", "Lyon". */
  query: string;
  op: AlertOp;
  /** Price, % (move), °C or km/h; none for rain. */
  threshold?: number;
  createdAt: number;
  /** Resolved the first time (Yahoo symbol, city coordinates) so later checks are one request. */
  symbol?: string;
  coords?: GeoPoint;
  /** Display name and unit ("Bitcoin USD", "USD"). */
  name?: string;
  unit?: string;
  /** Price when the alert was set (for `move`). */
  base?: number;
  /** Last reading, shown in the task tray. */
  last?: string;
  lastCheck?: number;
}

export interface Reading {
  /** Price, or temperature for the weather. */
  value: number;
  unit: string;
  name: string;
  /** Weather only. */
  code?: number;
  wind?: number;
  label?: string;
}

/** WMO codes that mean rain, snow or storms. */
const WET = (code: number) => (code >= 51 && code <= 67) || (code >= 71 && code <= 86) || code >= 95;

/** Whether a reading meets the alert's condition. Pure: see alerts.test.ts. */
export function isMet(alert: Pick<Alert, 'op' | 'threshold' | 'base'>, r: Reading): boolean {
  const t = alert.threshold ?? 0;
  switch (alert.op) {
    case 'above':
    case 'temp_above':
      return r.value >= t;
    case 'below':
    case 'temp_below':
      return r.value <= t;
    case 'move':
      return alert.base !== undefined && alert.base !== 0 && (Math.abs(r.value - alert.base) / alert.base) * 100 >= t;
    case 'rain':
      return r.code !== undefined && WET(r.code);
    case 'wind_above':
      return (r.wind ?? 0) >= t;
  }
}

const fmt = (v: number, lang: string) => v.toLocaleString(lang, { maximumFractionDigits: v >= 100 ? 0 : 2 });

/** "Bitcoin passe sous 80 000 USD" — what the alert watches, for the tray and the model. */
export function describeAlert(a: Alert, fr: boolean): string {
  const name = a.name ?? a.query;
  const lang = fr ? 'fr' : 'en';
  const t = a.threshold !== undefined ? fmt(a.threshold, lang) : '';
  const u = a.unit ? ` ${a.unit}` : '';
  switch (a.op) {
    case 'above':
      return fr ? `${name} au-dessus de ${t}${u}` : `${name} above ${t}${u}`;
    case 'below':
      return fr ? `${name} sous ${t}${u}` : `${name} below ${t}${u}`;
    case 'move':
      return fr ? `${name} bouge de ${t} %` : `${name} moves ${t}%`;
    case 'rain':
      return fr ? `Pluie à ${name}` : `Rain in ${name}`;
    case 'temp_above':
      return fr ? `${name} au-dessus de ${t} °C` : `${name} above ${t} °C`;
    case 'temp_below':
      return fr ? `${name} sous ${t} °C` : `${name} below ${t} °C`;
    case 'wind_above':
      return fr ? `Vent à ${name} au-dessus de ${t} km/h` : `Wind in ${name} above ${t} km/h`;
  }
}

/** The spoken line when it fires ("Monsieur, bitcoin vient de passer sous 80 000 USD : 79 850."). */
export function firedLine(a: Alert, r: Reading, fr: boolean, honorific: string): string {
  const lang = fr ? 'fr' : 'en';
  const hon = honorific ? `${honorific}, ` : '';
  const Hon = hon ? hon.charAt(0).toUpperCase() + hon.slice(1) : '';
  const value = `${fmt(r.value, lang)} ${r.unit}`.trim();
  if (a.source === 'weather') {
    return fr
      ? `${Hon}alerte météo à ${r.name} : ${r.label ?? ''}, ${value}${r.wind !== undefined ? `, vent ${Math.round(r.wind)} km/h` : ''}.`
      : `${Hon}weather alert in ${r.name}: ${r.label ?? ''}, ${value}${r.wind !== undefined ? `, wind ${Math.round(r.wind)} km/h` : ''}.`;
  }
  return fr ? `${Hon}alerte : ${describeAlert(a, true)} — ${value} en ce moment.` : `${Hon}alert: ${describeAlert(a, false)} — ${value} right now.`;
}

// ---------------------------------------------------------------- readings

/** Current value of what an alert watches; resolves (and remembers) its symbol or coordinates. */
export async function readAlert(a: Alert, lang: string): Promise<Reading> {
  if (a.source === 'quote') {
    const q = a.symbol ? await fetchQuoteForSymbol(a.symbol) : await fetchQuote(a.query, lang);
    a.symbol = q.symbol;
    a.name ??= q.name;
    a.unit ??= q.currency;
    return { value: q.price, unit: q.currency, name: q.name };
  }
  const w = a.coords ? { ...(await fetchForecast(a.coords.lat, a.coords.lon)), coords: a.coords } : await fetchWeather(a.query, lang);
  a.coords = w.coords as GeoPoint;
  a.name ??= (w.coords as GeoPoint).name;
  return { value: w.current.temperature, unit: '°C', name: a.name ?? a.query, code: w.current.code, wind: w.current.wind, label: describeWeather(w.current.code, lang).label };
}

// ---------------------------------------------------------------- store

const FILE = 'alerts';
let alerts: Alert[] = [];
let loaded: Promise<void> | null = null;
const listeners = new Set<() => void>();

function save() {
  invoke('memory_write', { name: FILE, content: JSON.stringify(alerts) }).catch((error) => console.warn('[iris:alerts] could not save', error));
  listeners.forEach((l) => l());
}

export const alertStore = {
  load(): Promise<void> {
    loaded ??= invoke<string | null>('memory_read', { name: FILE })
      .then((raw) => {
        alerts = raw ? (JSON.parse(raw) as Alert[]) : [];
        listeners.forEach((l) => l());
      })
      .catch((error) => console.warn('[iris:alerts] could not read', error));
    return loaded;
  },
  list: () => alerts,
  add(alert: Alert) {
    alerts = [...alerts, alert];
    save();
  },
  remove(id: string) {
    const before = alerts.length;
    alerts = alerts.filter((a) => a.id !== id);
    if (alerts.length !== before) save();
  },
  update(alert: Alert) {
    alerts = alerts.map((a) => (a.id === alert.id ? alert : a));
    save();
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

// ---------------------------------------------------------------- watcher

const EVERY_MS: Record<AlertSource, number> = { quote: 60_000, weather: 10 * 60_000 };

/**
 * Checks the alerts in the background (also while the interface is hidden: Iris lives in the
 * tray). `onFire` is called once per alert, which is then removed.
 */
export function watchAlerts(lang: () => string, onFire: (alert: Alert, reading: Reading) => void, onReading: (alert: Alert) => void): () => void {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      for (const a of [...alertStore.list()]) {
        if (a.lastCheck && Date.now() - a.lastCheck < EVERY_MS[a.source]) continue;
        try {
          const r = await readAlert(a, lang());
          const next = { ...a, lastCheck: Date.now(), last: `${fmt(r.value, lang())} ${r.unit}`.trim() };
          if (isMet(next, r)) {
            alertStore.remove(a.id);
            onFire(next, r);
          } else {
            alertStore.update(next);
            onReading(next);
          }
        } catch (error) {
          console.warn(`[iris:alerts] ${a.query}`, error);
          alertStore.update({ ...a, lastCheck: Date.now() });
        }
      }
    } finally {
      busy = false;
    }
  };
  void alertStore.load().then(tick);
  const timer = window.setInterval(() => void tick(), 20_000);
  return () => window.clearInterval(timer);
}
