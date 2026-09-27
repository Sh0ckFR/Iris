import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import type { ToolGroup } from './toolGroups';
import type { CalendarEvent } from '../../lib/calendar';
import type { MailSummary } from '../../lib/mail';

/**
 * Proactivity: Iris speaks up by herself when something deserves it, the way a real assistant
 * would — "votre réunion commence dans 10 minutes", "Claire vous a écrit au sujet du devis :
 * voulez-vous que je vous le lise ?", "il va pleuvoir vers 17 h", the morning briefing, a
 * birthday from her memory. Cheap by design: the watching is local (calendar, inbox, weather:
 * no tokens); most lines are ready-made; the model only writes the few that need judgement
 * (an important e-mail, the day's memories — one small call a day).
 *
 * What's here is the logic (signals, when to speak, the words); useProactivity.ts runs it.
 */

export type SignalKind = 'event' | 'mail' | 'rain' | 'memory' | 'morning';

export interface Signal {
  /** Never said twice (kept for a few days). */
  key: string;
  kind: SignalKind;
  /** Higher first. */
  priority: number;
  /** The words, in French and English (0 token) — or `compose` for the model. */
  line?: { fr: string; en: string };
  /** Facts for the model when it writes the line (English). */
  compose?: string;
  /** Tool groups the answer to Iris's offer ("oui") will need. */
  groups?: ToolGroup[];
  /** Too late after this (Unix ms). */
  expires: number;
}

/** Quiet hours (start → end, may wrap past midnight): Iris never speaks up by herself then. */
export function inQuietHours(date: Date, start: number, end: number): boolean {
  const h = date.getHours();
  if (start === end) return false;
  return start < end ? h >= start && h < end : h >= start || h < end;
}

/** "Monsieur, " / "" (the honorific, capitalized at the start of a line). */
function lead(honorific: string): string {
  return honorific ? `${honorific}, ` : '';
}

const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000));
const clock = (ms: number) => new Date(ms).toLocaleTimeString(navigator.language, { hour: '2-digit', minute: '2-digit' });

// ---------------------------------------------------------------- sources

/** Meetings about to start: 3 to 20 minutes ahead (all-day events go to the morning briefing). */
export function eventSignals(events: CalendarEvent[], now: number, honorific: { fr: string; en: string }): Signal[] {
  return events
    .filter((e) => !e.allDay && e.start - now >= 3 * 60_000 && e.start - now <= 20 * 60_000)
    .map((e) => {
      const n = minutes(e.start - now);
      const place = e.location ? ` (${e.location})` : '';
      return {
        key: `event:${e.uid}:${e.start}`,
        kind: 'event',
        priority: 90,
        line: {
          fr: `${lead(honorific.fr)}« ${e.title} » commence dans ${n} minute${n > 1 ? 's' : ''}${place}.`,
          en: `${lead(honorific.en)}"${e.title}" starts in ${n} minute${n > 1 ? 's' : ''}${place}.`,
        },
        groups: ['personal'],
        expires: e.start,
      };
    });
}

const URGENT = /\b(urgent|urgence|asap|important|imm[ée]diat|deadline|[ée]ch[ée]ance|relance|reminder|facture impay|overdue)\b/i;

/**
 * New e-mails worth mentioning: from someone who matters to the user (a person of the knowledge
 * graph or named in the memory) or marked urgent — each on its own, written by the model with
 * what Iris knows about the sender. The others are only counted: five of them make one line.
 */
export function mailSignals(
  fresh: MailSummary[],
  knownPeople: string[],
  pendingOrdinary: number,
  now: number,
  honorific: { fr: string; en: string },
): { signals: Signal[]; ordinary: number } {
  const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const people = knownPeople.map(norm).filter((p) => p.length >= 3);
  const signals: Signal[] = [];
  let ordinary = pendingOrdinary;
  for (const m of fresh) {
    const who = norm(`${m.from} ${m.address}`);
    const known = people.find((p) => who.includes(p) || p.split(' ').some((part) => part.length >= 4 && who.includes(part)));
    if (known || URGENT.test(m.subject)) {
      signals.push({
        key: `mail:${m.address}:${m.uid}`,
        kind: 'mail',
        priority: known ? 70 : 60,
        compose: `A new e-mail has just arrived. From: ${m.from} <${m.address}>. Subject: "${m.subject}".${known ? ` The sender matches someone the user knows ("${known}").` : ' Its subject looks urgent.'}`,
        groups: ['personal'],
        expires: now + 3 * 3600_000,
      });
    } else ordinary++;
  }
  if (ordinary >= 5) {
    signals.push({
      key: `mails:${now}`,
      kind: 'mail',
      priority: 20,
      line: {
        fr: `${lead(honorific.fr)}vous avez ${ordinary} nouveaux e-mails. Voulez-vous que je vous les résume ?`,
        en: `${lead(honorific.en)}you have ${ordinary} new e-mails. Would you like a summary?`,
      },
      groups: ['personal'],
      expires: now + 6 * 3600_000,
    });
    ordinary = 0;
  }
  return { signals, ordinary };
}

/** Rain coming in the next two hours while it's dry now (Open-Meteo, free). */
export async function rainSignal(city: string, now: number, honorific: { fr: string; en: string }): Promise<Signal | null> {
  const geo = (await (
    await tauriFetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&format=json`)
  ).json()) as { results?: { name: string; latitude: number; longitude: number }[] };
  const place = geo.results?.[0];
  if (!place) return null;
  const data = (await (
    await tauriFetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current=precipitation&hourly=precipitation_probability&forecast_hours=3&timezone=auto`,
    )
  ).json()) as { current?: { precipitation?: number }; hourly?: { time: string[]; precipitation_probability: (number | null)[] } };
  if ((data.current?.precipitation ?? 0) > 0.1) return null; // already raining: nothing to warn about
  const hours = data.hourly;
  if (!hours) return null;
  // The coming hours (the times are the city's local ones, like this device's in practice).
  const index = hours.time.findIndex((t, i) => Date.parse(t) + 3600_000 > now && (hours.precipitation_probability[i] ?? 0) >= 60);
  if (index < 0) return null;
  const at = Math.max(now, Date.parse(hours.time[index]) || now);
  const p = hours.precipitation_probability[index] ?? 60;
  const halfDay = `${new Date(now).toDateString()}:${new Date(now).getHours() < 13 ? 'am' : 'pm'}`;
  return {
    key: `rain:${halfDay}`,
    kind: 'rain',
    priority: 50,
    line: {
      fr: `${lead(honorific.fr)}il risque de pleuvoir à ${place.name} vers ${clock(at)} (${p} %). Pensez au parapluie si vous sortez.`,
      en: `${lead(honorific.en)}rain is likely in ${place.name} around ${clock(at)} (${p}%). Take an umbrella if you go out.`,
    },
    expires: Math.max(at, now + 30 * 60_000),
  };
}

/** Once a day, in the morning, the first time the user is there. */
export function morningSignal(now: Date, honorific: { fr: string; en: string }): Signal | null {
  if (now.getHours() < 6 || now.getHours() >= 11) return null;
  const end = new Date(now);
  end.setHours(11, 0, 0, 0);
  return {
    key: `morning:${now.toDateString()}`,
    kind: 'morning',
    priority: 80,
    line: {
      fr: `Bonjour${honorific.fr ? ` ${honorific.fr}` : ''}. Voulez-vous le point du matin ?`,
      en: `Good morning${honorific.en ? `, ${honorific.en}` : ''}. Would you like your morning briefing?`,
    },
    groups: ['personal', 'schedule'],
    expires: end.getTime(),
  };
}

// ---------------------------------------------------------------- the model's lines

/** One important e-mail → one or two spoken sentences, ending with an offer. */
export function composeSystem(language: 'fr' | 'en', honorific: string): string {
  return `You are Iris, a courteous personal assistant, speaking up by yourself (the user did not ask). Write ONE or TWO short spoken sentences in ${language === 'fr' ? 'French (use "vous")' : 'English'} telling the user about the event below, saying why it may matter when the memories make it clear, and ending with a short offer phrased as a question (e.g. read it, summarize it, remind later). ${honorific ? `Address the user as "${honorific}".` : ''} Plain text only: no markdown, no emojis, no quotes around the answer. If the event is clearly not worth interrupting the user for, answer exactly SKIP.`;
}

/**
 * Once a day: the memory and the day's calendar checked for what deserves a word today —
 * birthdays, anniversaries, deadlines, plans the user mentioned. One small call.
 */
export function dailyMemorySystem(language: 'fr' | 'en', honorific: string): string {
  return `You are Iris, a personal assistant. Below: today's date, what you remember about the user, and today's calendar. Find at most TWO things that deserve a proactive word TODAY: a birthday or anniversary today or tomorrow, a deadline, a trip or event today or tomorrow, a plan the user mentioned for around now. Ignore everything else — most days there is nothing.
Reply with ONLY a JSON array (no markdown): [{"text": "..."}] where each text is one or two short spoken sentences in ${language === 'fr' ? 'French (use "vous")' : 'English'} ending with a helpful offer as a question${honorific ? `, addressing the user as "${honorific}"` : ''}. Only use facts given below; never invent. [] when nothing qualifies.`;
}

export function parseDailyMemory(text: string): string[] {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  try {
    const items = JSON.parse(text.slice(start, end + 1)) as { text?: unknown }[];
    return items
      .map((i) => (typeof i?.text === 'string' ? i.text.trim() : ''))
      .filter((t) => t.length > 5 && t.length < 400)
      .slice(0, 2);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- choosing

export interface DeliveryState {
  now: number;
  /** When Iris last spoke up by herself. */
  lastSpokeAt: number;
  /** How many times today. */
  today: number;
  delivered: Set<string>;
}

const GAP_MS = 8 * 60_000;
/** Meeting reminders are time-critical: only a short gap after another proactive line. */
const URGENT_GAP_MS = 60_000;
export const DAILY_CAP = 12;

/** The signal to say now, if any: the most important one still valid and not said yet. */
export function pickSignal(signals: Signal[], s: DeliveryState): Signal | null {
  if (s.today >= DAILY_CAP) return null;
  const candidates = signals
    .filter((x) => x.expires > s.now && !s.delivered.has(x.key))
    .filter((x) => s.now - s.lastSpokeAt >= (x.kind === 'event' ? URGENT_GAP_MS : GAP_MS))
    .sort((a, b) => b.priority - a.priority);
  return candidates[0] ?? null;
}
