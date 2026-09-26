import { invoke } from '@tauri-apps/api/core';

/**
 * Things Iris does at a given time, kept on disk (`<app data>/memory/schedule.json`) so they
 * survive restarts: a reminder ("rappelle-moi à 17 h d'appeler Claire"), a request run for the
 * user ("chaque lundi à 9 h, un résumé des marchés"), a dashboard shown ("chaque matin à 8 h,
 * affiche mon écran du matin"). Waiting costs nothing; a request costs its tokens when it runs.
 */

export type ScheduleWhen = { kind: 'once'; at: number } | { kind: 'repeat'; time: string; days: number[] };

export type ScheduleAction =
  /** Said as it is. */
  | { kind: 'remind'; text: string }
  /** Asked to Iris as if the user had just said it (answered aloud). */
  | { kind: 'ask'; prompt: string }
  /** A pinned dashboard shown, then optionally a request. */
  | { kind: 'dashboard'; name: string; prompt?: string };

export interface Scheduled {
  id: string;
  label: string;
  when: ScheduleWhen;
  action: ScheduleAction;
  /** Next time it runs (ms). */
  nextAt: number;
  createdAt: number;
  lastRunAt?: number;
}

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_ALIASES: Record<string, number[]> = {
  daily: [0, 1, 2, 3, 4, 5, 6],
  everyday: [0, 1, 2, 3, 4, 5, 6],
  weekdays: [1, 2, 3, 4, 5],
  weekends: [0, 6],
  lun: [1], mar: [2], mer: [3], jeu: [4], ven: [5], sam: [6], dim: [0],
};

/** ["mon", "wed"], "weekdays", "daily"… → day numbers (0 = Sunday). */
export function parseDays(days: string[] | string | undefined): number[] {
  const list = (Array.isArray(days) ? days : days ? [days] : []).map((d) => d.toLowerCase().trim());
  const out = new Set<number>();
  for (const d of list) {
    if (DAY_ALIASES[d]) DAY_ALIASES[d].forEach((n) => out.add(n));
    else if (DAYS.includes(d.slice(0, 3))) out.add(DAYS.indexOf(d.slice(0, 3)));
  }
  return [...out].sort();
}

/** "17:00" or "17h30" → [17, 30]; null if not a time. */
function parseClock(text: string): [number, number] | null {
  const m = /^(\d{1,2})\s*[:hH]\s*(\d{2})?$/.exec(text.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  return h < 24 && min < 60 ? [h, min] : null;
}

/**
 * When it next runs after `from`: a one-off time (null once passed), or the next matching day at
 * that time. Pure: see schedule.test.ts.
 */
export function nextOccurrence(when: ScheduleWhen, from: Date): number | null {
  if (when.kind === 'once') return when.at > from.getTime() ? when.at : null;
  const clock = parseClock(when.time);
  if (!clock || when.days.length === 0) return null;
  for (let d = 0; d <= 7; d++) {
    const c = new Date(from);
    c.setDate(from.getDate() + d);
    c.setHours(clock[0], clock[1], 0, 0);
    if (c.getTime() > from.getTime() && when.days.includes(c.getDay())) return c.getTime();
  }
  return null;
}

/**
 * The model's "at" and "days" → when: "17:00" alone is today (tomorrow if already passed), an
 * ISO date is that moment, "08:00" with days repeats. Null when it can't be read.
 */
export function parseWhen(at: string, days: string[] | string | undefined, now = new Date()): ScheduleWhen | null {
  const dayList = parseDays(days);
  const clock = parseClock(at);
  if (dayList.length) return clock ? { kind: 'repeat', time: `${clock[0]}:${String(clock[1]).padStart(2, '0')}`, days: dayList } : null;
  if (clock) {
    const t = new Date(now);
    t.setHours(clock[0], clock[1], 0, 0);
    if (t.getTime() <= now.getTime()) t.setDate(t.getDate() + 1);
    return { kind: 'once', at: t.getTime() };
  }
  const ms = Date.parse(at);
  return Number.isFinite(ms) && ms > now.getTime() ? { kind: 'once', at: ms } : null;
}

/** "tous les jours à 8:00", "lun., mer. à 9:00", "demain à 17:00"… for the tray and the model. */
export function describeWhen(when: ScheduleWhen, fr: boolean, now = new Date()): string {
  if (when.kind === 'once') {
    const d = new Date(when.at);
    const sameDay = d.toDateString() === now.toDateString();
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);
    const time = d.toLocaleTimeString(fr ? 'fr-FR' : 'en-US', { hour: '2-digit', minute: '2-digit' });
    if (sameDay) return fr ? `aujourd'hui à ${time}` : `today at ${time}`;
    if (d.toDateString() === tomorrow.toDateString()) return fr ? `demain à ${time}` : `tomorrow at ${time}`;
    return d.toLocaleString(fr ? 'fr-FR' : 'en-US', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
  }
  const names = fr ? ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.'] : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const days =
    when.days.length === 7 ? (fr ? 'tous les jours' : 'every day') : when.days.join() === '1,2,3,4,5' ? (fr ? 'en semaine' : 'on weekdays') : when.days.map((d) => names[d]).join(', ');
  return fr ? `${days} à ${when.time}` : `${days} at ${when.time}`;
}

// ---------------------------------------------------------------- store

const FILE = 'schedule';
let entries: Scheduled[] = [];
let loaded: Promise<void> | null = null;

function save() {
  invoke('memory_write', { name: FILE, content: JSON.stringify(entries) }).catch((error) => console.warn('[iris:schedule] could not save', error));
}

export const scheduleStore = {
  load(): Promise<void> {
    loaded ??= invoke<string | null>('memory_read', { name: FILE })
      .then((raw) => {
        entries = raw ? (JSON.parse(raw) as Scheduled[]) : [];
      })
      .catch((error) => console.warn('[iris:schedule] could not read', error));
    return loaded;
  },
  list: () => entries,
  add(entry: Scheduled) {
    entries = [...entries, entry];
    save();
  },
  update(entry: Scheduled) {
    entries = entries.map((e) => (e.id === entry.id ? entry : e));
    save();
  },
  remove(id: string) {
    const before = entries.length;
    entries = entries.filter((e) => e.id !== id);
    if (entries.length !== before) save();
  },
};

/** Late by more than this (Iris was closed): a repeating task waits for its next time, a one-off still runs, saying so. */
export const LATE_MS = 30 * 60_000;
/** One-off reminders missed by more than this are dropped (said as missed). */
export const TOO_LATE_MS = 12 * 3600_000;
