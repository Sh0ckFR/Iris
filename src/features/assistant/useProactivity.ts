import { useEffect, useRef, type MutableRefObject } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { Settings } from '../../lib/settings';
import type { Secrets } from '../../lib/secrets';
import { IS_MOBILE } from '../../lib/platform';
import { calendarEvents, parseCalendarUrls } from '../../lib/calendar';
import { parseMailAccount, unreadMail } from '../../lib/mail';
import { memoryStore } from '../../lib/memory';
import { knowledgeStore } from '../../lib/knowledge';
import { semanticMemory } from '../../lib/semantic';
import { playSfx } from './sfx';
import type { ToolGroup } from './toolGroups';
import {
  composeSystem,
  dailyMemorySystem,
  eventSignals,
  inQuietHours,
  mailSignals,
  morningSignal,
  parseDailyMemory,
  pickSignal,
  rainSignal,
  type Signal,
} from './proactive';

/**
 * Runs Iris's proactivity (see proactive.ts): watches the calendar (every minute), the inbox
 * (every 5 minutes), the weather (every 30 minutes) and, once a day, the memory; and speaks when
 * something deserves it — never during the quiet hours, only when someone is there, never while
 * she is busy or the user is talking to her, at most once every few minutes.
 */

interface Options {
  live: MutableRefObject<{ settings: Settings; secrets: Secrets }>;
  /** A request is running, Iris is speaking, an approval waits, or the user just spoke to her. */
  isBusy: () => boolean;
  say: (text: string, channel: string) => Promise<void>;
  /** Shows Iris's line in the conversation (so a "oui" that follows has its context). */
  addReply: (content: string, label: string) => void;
  /** One-shot call to the chat brain. */
  generate: (system: string, content: string) => Promise<string>;
  honorific: (lang: 'fr' | 'en') => string;
  replyLang: () => 'fr' | 'en';
  /** The tools the answer to Iris's offer will need stay available for the next request. */
  offerGroups: (groups: ToolGroup[]) => void;
}

// ---------------------------------------------------------------- presence

let lastActivity = Date.now();
/** The user did something with Iris (spoke, typed, clicked): they are there. */
export function markActivity() {
  lastActivity = Date.now();
}

/** Someone is at the computer (keyboard / mouse in the last minutes), or around the app. */
async function userPresent(): Promise<boolean> {
  if (IS_MOBILE) return document.visibilityState === 'visible' || Date.now() - lastActivity < 10 * 60_000;
  const idle = await invoke<number | null>('user_idle_seconds').catch(() => null);
  if (idle !== null) return idle <= 5 * 60 || Date.now() - lastActivity < 5 * 60_000;
  return Date.now() - lastActivity < 10 * 60_000;
}

// ---------------------------------------------------------------- what was said (kept a few days)

const DELIVERED_KEY = 'iris.proactive.delivered';
const MAIL_KEY = 'iris.proactive.mail';
const DAILY_KEY = 'iris.proactive.daily';

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // forgotten at the next launch: at worst a line is said again
  }
}

function deliveredLog(): Record<string, number> {
  const log = readJson<Record<string, number>>(DELIVERED_KEY, {});
  const cutoff = Date.now() - 4 * 86_400_000;
  return Object.fromEntries(Object.entries(log).filter(([, at]) => at > cutoff));
}

export function useProactivity(o: Options) {
  const latest = useRef(o);
  latest.current = o;

  useEffect(() => {
    // Interacting with the window counts as being there.
    const onInput = () => markActivity();
    window.addEventListener('keydown', onInput);
    window.addEventListener('pointerdown', onInput);

    const signals = new Map<string, Signal>();
    const add = (list: Signal[]) => list.forEach((s) => signals.set(s.key, s));
    let lastSpokeAt = 0;
    let lastMailCheck = 0;
    let lastRainCheck = 0;
    let delivering = false;
    let alive = true;

    const honorifics = () => ({ fr: latest.current.honorific('fr'), en: latest.current.honorific('en') });

    /** Local watching (no tokens), every minute. */
    const watch = async () => {
      const { settings, secrets } = latest.current.live.current;
      if (!settings.proactive) return;
      const now = Date.now();
      const hon = honorifics();
      const calendars = parseCalendarUrls(secrets.calendar);
      if (calendars.length) {
        const { events } = await calendarEvents(calendars, now, now + 25 * 60_000).catch(() => ({ events: [] }));
        add(eventSignals(events, now, hon));
      }
      const account = parseMailAccount(secrets.mail);
      if (account && now - lastMailCheck >= 5 * 60_000) {
        lastMailCheck = now;
        try {
          const unread = await unreadMail(account, true);
          const id = `${account.user}@${account.host}`;
          const state = readJson<{ id?: string; maxUid?: number; ordinary?: number }>(MAIL_KEY, {});
          const maxUid = Math.max(0, ...unread.map((m) => m.uid));
          if (state.id !== id || state.maxUid === undefined) {
            // First look at this inbox: what is there now is not "new".
            writeJson(MAIL_KEY, { id, maxUid, ordinary: 0 });
          } else {
            const fresh = unread.filter((m) => m.uid > (state.maxUid ?? 0));
            const people = knowledgeStore
              .syncState()
              .entities.filter((e) => e.type === 'person')
              .map((e) => e.name);
            const { signals: found, ordinary } = mailSignals(fresh, people, state.ordinary ?? 0, now, hon);
            add(found);
            writeJson(MAIL_KEY, { id, maxUid: Math.max(maxUid, state.maxUid ?? 0), ordinary });
          }
        } catch (error) {
          console.warn('[iris:proactive] inbox check failed', error);
        }
      }
      if (settings.weatherCity.trim() && now - lastRainCheck >= 30 * 60_000) {
        lastRainCheck = now;
        const rain = await rainSignal(settings.weatherCity.trim(), now, hon).catch(() => null);
        if (rain) add([rain]);
      }
      const morning = morningSignal(new Date(now), hon);
      if (morning) add([morning]);
    };

    /** Once a day, when the user is there: the memory (and the day's calendar) read by the model. */
    const daily = async () => {
      const { settings, secrets } = latest.current.live.current;
      const today = new Date().toDateString();
      if (!settings.proactive || readJson<string>(DAILY_KEY, '') === today || new Date().getHours() < 7) return;
      await memoryStore.load();
      const facts = memoryStore.promptFacts();
      if (!facts) return;
      writeJson(DAILY_KEY, today);
      const lang = latest.current.replyLang();
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      const calendars = parseCalendarUrls(secrets.calendar);
      const agenda = calendars.length
        ? (await calendarEvents(calendars, start.getTime(), start.getTime() + 2 * 86_400_000).catch(() => ({ events: [] }))).events
            .map((e) => `- ${new Date(e.start).toLocaleString('en-GB')}: ${e.title}`)
            .join('\n')
        : '';
      try {
        const answer = await latest.current.generate(
          dailyMemorySystem(lang, latest.current.honorific(lang)),
          `Today: ${new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}.\n\nWhat you remember about the user:\n${facts}\n\nCalendar (today and tomorrow):\n${agenda || '(not connected)'}`,
        );
        const end = new Date();
        end.setHours(21, 0, 0, 0);
        parseDailyMemory(answer).forEach((text, i) =>
          add([{ key: `memory:${today}:${i}`, kind: 'memory', priority: 40, line: { fr: text, en: text }, expires: end.getTime() }]),
        );
      } catch (error) {
        console.warn('[iris:proactive] daily memory check failed', error);
      }
    };

    /** Every 30 s: says the most important thing, if the moment is right. */
    const deliver = async () => {
      if (delivering) return;
      const { settings } = latest.current.live.current;
      const now = Date.now();
      signals.forEach((s, key) => s.expires <= now && signals.delete(key));
      if (!settings.proactive || signals.size === 0 || inQuietHours(new Date(now), settings.quietStart, settings.quietEnd)) return;
      if (latest.current.isBusy() || !(await userPresent())) return;
      const log = deliveredLog();
      const midnight = new Date(now).setHours(0, 0, 0, 0);
      const signal = pickSignal([...signals.values()], {
        now,
        lastSpokeAt,
        today: Object.values(log).filter((at) => at >= midnight).length,
        delivered: new Set(Object.keys(log)),
      });
      if (!signal) return;
      delivering = true;
      try {
        const lang = latest.current.replyLang();
        let text = signal.line ? signal.line[lang] : '';
        if (!text && signal.compose) {
          const memories = await semanticMemory.relevantFor(signal.compose, new Set(), 1500);
          text = (
            await latest.current.generate(composeSystem(lang, latest.current.honorific(lang)), `${signal.compose}${memories ? `\n\nWhat you remember that may be relevant:\n${memories}` : ''}`)
          ).trim();
        }
        writeJson(DELIVERED_KEY, { ...log, [signal.key]: now });
        signals.delete(signal.key);
        if (!text || /^SKIP\b/i.test(text)) return;
        // The moment may have passed while the line was being written.
        if (!alive || latest.current.isBusy()) return;
        lastSpokeAt = Date.now();
        console.warn(`[iris:proactive] ${signal.kind}: ${text}`);
        if (signal.groups?.length) latest.current.offerGroups(signal.groups);
        playSfx(signal.kind === 'event' || signal.kind === 'rain' ? 'alert' : 'listen');
        latest.current.addReply(text, `Iris · ${lang === 'fr' ? 'initiative' : 'proactive'}`);
        void latest.current.say(text, 'proactive');
      } catch (error) {
        console.warn('[iris:proactive] could not speak up', error);
      } finally {
        delivering = false;
      }
    };

    const first = window.setTimeout(() => void watch().then(deliver), 30_000);
    const watching = window.setInterval(() => void watch(), 60_000);
    const delivering_ = window.setInterval(() => void deliver(), 30_000);
    const dailyTimer = window.setInterval(
      () =>
        void userPresent().then((here) => {
          if (here) void daily();
        }),
      10 * 60_000,
    );
    return () => {
      alive = false;
      window.clearTimeout(first);
      window.clearInterval(watching);
      window.clearInterval(delivering_);
      window.clearInterval(dailyTimer);
      window.removeEventListener('keydown', onInput);
      window.removeEventListener('pointerdown', onInput);
    };
  }, []);
}
