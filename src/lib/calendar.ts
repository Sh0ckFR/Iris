import { invoke } from '@tauri-apps/api/core';

/**
 * The user's calendars, read only, from their private iCalendar (.ics) addresses (Settings →
 * Proactivity): Google Calendar ("secret address in iCal format"), iCloud (public calendar
 * link), Outlook ("publish a calendar" → ICS), Nextcloud, Proton… No account to connect: the
 * address is fetched like a web page (web_get, public internet only) and parsed here.
 *
 * Handled: time zones (IANA names, and the Windows names Outlook writes), all-day events,
 * recurring events (RRULE: daily / weekly / monthly / yearly, INTERVAL, COUNT, UNTIL, BYDAY,
 * BYMONTHDAY), excluded dates (EXDATE), moved or cancelled occurrences (RECURRENCE-ID).
 */

export interface CalendarEvent {
  uid: string;
  title: string;
  /** Unix ms. For all-day events: local midnight. */
  start: number;
  end: number;
  allDay: boolean;
  location?: string;
}

interface Property {
  name: string;
  params: Record<string, string>;
  value: string;
}

interface RawEvent {
  props: Property[];
}

// ---------------------------------------------------------------- parsing

function unfold(text: string): string[] {
  return text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
}

function parseProperty(line: string): Property | null {
  // NAME;PARAM=VALUE;PARAM="VAL:UE":VALUE — the first colon outside quotes ends the name part.
  let quoted = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted;
    else if (line[i] === ':' && !quoted) {
      colon = i;
      break;
    }
  }
  if (colon < 0) return null;
  const [name, ...rawParams] = line.slice(0, colon).split(';');
  const params: Record<string, string> = {};
  for (const p of rawParams) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: name.toUpperCase(), params, value: line.slice(colon + 1) };
}

const unescapeText = (s: string) => s.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');

export function parseIcs(text: string): RawEvent[] {
  const events: RawEvent[] = [];
  let current: RawEvent | null = null;
  let depth = 0; // nested components inside an event (VALARM)
  for (const line of unfold(text)) {
    if (/^BEGIN:VEVENT$/i.test(line)) {
      current = { props: [] };
      depth = 0;
    } else if (/^END:VEVENT$/i.test(line)) {
      if (current) events.push(current);
      current = null;
    } else if (current) {
      if (/^BEGIN:/i.test(line)) depth++;
      else if (/^END:/i.test(line)) depth--;
      else if (depth === 0) {
        const prop = parseProperty(line);
        if (prop) current.props.push(prop);
      }
    }
  }
  return events;
}

// ---------------------------------------------------------------- time zones

/** Windows time zone names (Outlook's TZID) → IANA, for the common ones. */
const WINDOWS_ZONES: Record<string, string> = {
  'Romance Standard Time': 'Europe/Paris',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Central Europe Standard Time': 'Europe/Budapest',
  'Central European Standard Time': 'Europe/Warsaw',
  'GMT Standard Time': 'Europe/London',
  'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'E. Europe Standard Time': 'Europe/Chisinau',
  'FLE Standard Time': 'Europe/Kiev',
  'Russian Standard Time': 'Europe/Moscow',
  'Turkey Standard Time': 'Europe/Istanbul',
  'Eastern Standard Time': 'America/New_York',
  'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Denver',
  'Pacific Standard Time': 'America/Los_Angeles',
  'Atlantic Standard Time': 'America/Halifax',
  'E. South America Standard Time': 'America/Sao_Paulo',
  'Morocco Standard Time': 'Africa/Casablanca',
  'South Africa Standard Time': 'Africa/Johannesburg',
  'Arabian Standard Time': 'Asia/Dubai',
  'India Standard Time': 'Asia/Kolkata',
  'China Standard Time': 'Asia/Shanghai',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'Korea Standard Time': 'Asia/Seoul',
  'AUS Eastern Standard Time': 'Australia/Sydney',
  'UTC': 'UTC',
};

function ianaZone(tzid: string | undefined): string | null {
  if (!tzid) return null;
  const name = WINDOWS_ZONES[tzid] ?? tzid.replace(/^\/[^/]+\/[^/]+\//, ''); // "/mozilla.org/…/Europe/Paris"
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name });
    return name;
  } catch {
    return null;
  }
}

interface Wall {
  y: number;
  m: number; // 1..12
  d: number;
  h: number;
  mi: number;
  s: number;
}

/** Offset (ms) of a zone from UTC at an instant. */
function zoneOffset(utcMs: number, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(new Date(utcMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** A wall-clock time in a zone (null zone: this device's local time) → Unix ms. */
function wallToMs(w: Wall, zone: string | null): number {
  if (!zone) return new Date(w.y, w.m - 1, w.d, w.h, w.mi, w.s).getTime();
  const guess = Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s);
  let result = guess - zoneOffset(guess, zone);
  result = guess - zoneOffset(result, zone); // second pass: right across DST changes
  return result;
}

interface DateValue {
  wall: Wall;
  zone: string | null;
  utc: boolean;
  allDay: boolean;
}

function parseDateValue(prop: Property | undefined): DateValue | null {
  if (!prop) return null;
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?/.exec(prop.value.trim());
  if (!m) return null;
  const allDay = !m[4] || prop.params.VALUE === 'DATE';
  const wall: Wall = { y: +m[1], m: +m[2], d: +m[3], h: allDay ? 0 : +m[4], mi: allDay ? 0 : +m[5], s: allDay ? 0 : +m[6] };
  const utc = !!m[7];
  return { wall, zone: utc ? 'UTC' : allDay ? null : ianaZone(prop.params.TZID), utc, allDay };
}

const toMs = (v: DateValue) => wallToMs(v.wall, v.zone);

/** Adds days / months to a wall-clock time (calendar arithmetic, DST-proof). */
function shift(w: Wall, days: number, months = 0): Wall {
  const date = new Date(Date.UTC(w.y, w.m - 1 + months, w.d + days));
  return { ...w, y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() };
}

const weekday = (w: Wall) => new Date(Date.UTC(w.y, w.m - 1, w.d)).getUTCDay(); // 0 = Sunday
const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

// ---------------------------------------------------------------- recurrence

interface Rule {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  interval: number;
  count?: number;
  until?: number;
  byDay: { n: number; day: number }[];
  byMonthDay: number[];
}

function parseRule(value: string | undefined): Rule | null {
  if (!value) return null;
  const parts = Object.fromEntries(value.split(';').map((p) => p.split('=') as [string, string]));
  const freq = parts.FREQ as Rule['freq'];
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) return null;
  const until = parts.UNTIL ? parseDateValue({ name: 'UNTIL', params: {}, value: parts.UNTIL }) : null;
  return {
    freq,
    interval: Math.max(1, Number(parts.INTERVAL) || 1),
    count: parts.COUNT ? Number(parts.COUNT) : undefined,
    until: until ? toMs(until) + (until.allDay ? 86_400_000 - 1 : 0) : undefined,
    byDay: (parts.BYDAY ?? '')
      .split(',')
      .filter(Boolean)
      .map((d) => {
        const m = /^([+-]?\d+)?([A-Z]{2})$/.exec(d);
        return m ? { n: m[1] ? Number(m[1]) : 0, day: DAYS.indexOf(m[2]) } : null;
      })
      .filter((d): d is { n: number; day: number } => !!d && d.day >= 0),
    byMonthDay: (parts.BYMONTHDAY ?? '').split(',').filter(Boolean).map(Number),
  };
}

/** The occurrences' start times (wall clock) of one period of a rule, in order. */
function periodStarts(rule: Rule, period: Wall, first: Wall): Wall[] {
  const time = { h: first.h, mi: first.mi, s: first.s };
  switch (rule.freq) {
    case 'DAILY':
      return [period];
    case 'WEEKLY': {
      if (!rule.byDay.length) return [period];
      // The week of `period`, from its Monday (RFC 5545's default week start).
      const monday = shift(period, -((weekday(period) + 6) % 7));
      return rule.byDay
        .map((b) => shift(monday, (b.day + 6) % 7))
        .sort((a, b) => a.y - b.y || a.m - b.m || a.d - b.d)
        .map((w) => ({ ...w, ...time }));
    }
    case 'MONTHLY':
    case 'YEARLY': {
      const y = period.y;
      const m = rule.freq === 'YEARLY' ? first.m : period.m;
      const dim = daysInMonth(y, m);
      let days: number[];
      if (rule.byMonthDay.length) days = rule.byMonthDay.map((d) => (d < 0 ? dim + d + 1 : d));
      else if (rule.byDay.length) {
        days = [];
        for (const b of rule.byDay) {
          const matching: number[] = [];
          for (let d = 1; d <= dim; d++) if (weekday({ ...period, y, m, d }) === b.day) matching.push(d);
          if (b.n === 0) days.push(...matching);
          else {
            const pick = b.n > 0 ? matching[b.n - 1] : matching[matching.length + b.n];
            if (pick) days.push(pick);
          }
        }
      } else days = [first.d];
      return days
        .filter((d) => d >= 1 && d <= dim)
        .sort((a, b) => a - b)
        .map((d) => ({ y, m, d, ...time }));
    }
  }
}

const MAX_OCCURRENCES = 2000;

/** Start times (ms) of a recurring event from its first start, up to `to`. */
function occurrences(rule: Rule, start: DateValue, to: number): number[] {
  const out: number[] = [];
  const firstMs = toMs(start);
  let emitted = 0;
  for (let i = 0; i < MAX_OCCURRENCES; i++) {
    const period =
      rule.freq === 'DAILY'
        ? shift(start.wall, i * rule.interval)
        : rule.freq === 'WEEKLY'
          ? shift(start.wall, i * 7 * rule.interval)
          : rule.freq === 'MONTHLY'
            ? { ...shift({ ...start.wall, d: 1 }, 0, i * rule.interval) }
            : { ...start.wall, d: 1, y: start.wall.y + i * rule.interval };
    for (const w of periodStarts(rule, period, start.wall)) {
      const ms = wallToMs(w, start.zone);
      if (ms < firstMs) continue;
      if ((rule.until !== undefined && ms > rule.until) || ms > to || (rule.count !== undefined && emitted >= rule.count)) return out;
      out.push(ms);
      emitted++;
    }
  }
  return out;
}

/** The events (occurrences of recurring ones included) that overlap [from, to], by start time. */
export function eventsBetween(raw: RawEvent[], from: number, to: number): CalendarEvent[] {
  const get = (e: RawEvent, name: string) => e.props.find((p) => p.name === name);
  const all = (e: RawEvent, name: string) => e.props.filter((p) => p.name === name);
  // Moved or cancelled occurrences: UID + original start → the replacement (or its cancellation).
  const overrides = new Map<string, RawEvent>();
  for (const e of raw) {
    const rid = parseDateValue(get(e, 'RECURRENCE-ID'));
    if (rid) overrides.set(`${get(e, 'UID')?.value}|${toMs(rid)}`, e);
  }
  const out: CalendarEvent[] = [];
  const add = (e: RawEvent, start: number, duration: number, allDay: boolean) => {
    if ((get(e, 'STATUS')?.value ?? '').toUpperCase() === 'CANCELLED') return;
    const end = start + duration;
    if (end < from || start > to) return;
    out.push({
      uid: get(e, 'UID')?.value ?? `${start}`,
      title: unescapeText(get(e, 'SUMMARY')?.value ?? '(untitled)'),
      start,
      end,
      allDay,
      location: get(e, 'LOCATION') ? unescapeText(get(e, 'LOCATION')!.value) : undefined,
    });
  };
  for (const e of raw) {
    if (get(e, 'RECURRENCE-ID')) continue; // added through its series
    const start = parseDateValue(get(e, 'DTSTART'));
    if (!start) continue;
    const endValue = parseDateValue(get(e, 'DTEND'));
    const startMs = toMs(start);
    const duration = endValue ? Math.max(0, toMs(endValue) - startMs) : start.allDay ? 86_400_000 : 0;
    const rule = parseRule(get(e, 'RRULE')?.value);
    if (!rule) {
      add(e, startMs, duration, start.allDay);
      continue;
    }
    const excluded = new Set(
      all(e, 'EXDATE').flatMap((p) =>
        p.value.split(',').map((v) => {
          const value = parseDateValue({ ...p, value: v });
          return value ? toMs({ ...value, zone: value.zone ?? start.zone }) : NaN;
        }),
      ),
    );
    const uid = get(e, 'UID')?.value;
    for (const ms of occurrences(rule, start, to)) {
      if (excluded.has(ms)) continue;
      const override = overrides.get(`${uid}|${ms}`);
      if (override) {
        const s = parseDateValue(get(override, 'DTSTART'));
        const en = parseDateValue(get(override, 'DTEND'));
        if (s) add(override, toMs(s), en ? toMs(en) - toMs(s) : duration, s.allDay);
      } else add(e, ms, duration, start.allDay);
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

// ---------------------------------------------------------------- the user's calendars

/** Calendar addresses saved in the vault: one per line. */
export function parseCalendarUrls(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(/[\n,]+/)
    .map((u) => u.trim().replace(/^webcal:\/\//i, 'https://'))
    .filter((u) => /^https?:\/\//i.test(u));
}

const cache = new Map<string, { at: number; events: RawEvent[] }>();
const CACHE_MS = 15 * 60_000;

async function load(url: string): Promise<RawEvent[]> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.events;
  const page = await invoke<{ status: number; body: string }>('web_get', { url, language: null });
  if (page.status >= 400) throw new Error(`calendar address answered HTTP ${page.status}`);
  if (!/BEGIN:VCALENDAR/i.test(page.body)) throw new Error('this address is not an iCalendar (.ics) calendar');
  const events = parseIcs(page.body);
  cache.set(url, { at: Date.now(), events });
  return events;
}

/** Events of all the user's calendars between two times; a calendar that fails is skipped. */
export async function calendarEvents(urls: string[], from: number, to: number): Promise<{ events: CalendarEvent[]; errors: string[] }> {
  const errors: string[] = [];
  const lists = await Promise.all(
    urls.map((url) =>
      load(url)
        .then((raw) => eventsBetween(raw, from, to))
        .catch((error: unknown) => {
          errors.push(error instanceof Error ? error.message : String(error));
          return [] as CalendarEvent[];
        }),
    ),
  );
  return { events: lists.flat().sort((a, b) => a.start - b.start), errors };
}
