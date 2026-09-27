import { describe, expect, it } from 'vitest';
import { eventsBetween, parseCalendarUrls, parseIcs } from './calendar';

const ics = (...events: string[]) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...events, 'END:VCALENDAR'].join('\r\n');
const vevent = (...lines: string[]) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT'].join('\r\n');
const iso = (ms: number) => new Date(ms).toISOString();
const range = (a: string, b: string) => [Date.parse(a), Date.parse(b)] as const;

describe('calendar (ICS)', () => {
  it('reads a UTC event, folded lines and escaped text', () => {
    const raw = parseIcs(ics(vevent('UID:1', 'DTSTART:20260928T070000Z', 'DTEND:20260928T080000Z', 'SUMMARY:Point \\, équipe', '  produit', 'LOCATION:Salle 2')));
    const [event] = eventsBetween(raw, ...range('2026-09-28T00:00:00Z', '2026-09-29T00:00:00Z'));
    expect(event.title).toBe('Point , équipe produit');
    expect(iso(event.start)).toBe('2026-09-28T07:00:00.000Z');
    expect(event.location).toBe('Salle 2');
  });

  it('converts time zones, Windows names included, across daylight saving', () => {
    const raw = parseIcs(
      ics(
        vevent('UID:paris', 'DTSTART;TZID=Europe/Paris:20260715T090000', 'DTEND;TZID=Europe/Paris:20260715T100000', 'SUMMARY:Été'),
        vevent('UID:outlook', 'DTSTART;TZID=Romance Standard Time:20261215T090000', 'SUMMARY:Hiver'),
      ),
    );
    const events = eventsBetween(raw, ...range('2026-01-01T00:00:00Z', '2026-12-31T00:00:00Z'));
    expect(iso(events[0].start)).toBe('2026-07-15T07:00:00.000Z'); // UTC+2 in summer
    expect(iso(events[1].start)).toBe('2026-12-15T08:00:00.000Z'); // UTC+1 in winter
  });

  it('expands weekly rules at the same local time after a DST change, with EXDATE and moved occurrences', () => {
    const raw = parseIcs(
      ics(
        vevent(
          'UID:weekly',
          'DTSTART;TZID=Europe/Paris:20261019T090000',
          'DTEND;TZID=Europe/Paris:20261019T093000',
          'RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=5',
          'EXDATE;TZID=Europe/Paris:20261021T090000',
          'SUMMARY:Standup',
        ),
        vevent('UID:weekly', 'RECURRENCE-ID;TZID=Europe/Paris:20261026T090000', 'DTSTART;TZID=Europe/Paris:20261026T110000', 'DTEND;TZID=Europe/Paris:20261026T113000', 'SUMMARY:Standup (déplacé)'),
      ),
    );
    const events = eventsBetween(raw, ...range('2026-10-01T00:00:00Z', '2026-12-01T00:00:00Z'));
    expect(events.map((e) => [iso(e.start), e.title])).toEqual([
      ['2026-10-19T07:00:00.000Z', 'Standup'],
      // Wednesday 21 excluded; Monday 26 moved to 11:00 (winter time: UTC+1)
      ['2026-10-26T10:00:00.000Z', 'Standup (déplacé)'],
      ['2026-10-28T08:00:00.000Z', 'Standup'],
      ['2026-11-02T08:00:00.000Z', 'Standup'],
    ]);
  });

  it('handles monthly "last Friday" rules, UNTIL and all-day events', () => {
    const raw = parseIcs(
      ics(
        vevent('UID:m', 'DTSTART:20260925T160000Z', 'RRULE:FREQ=MONTHLY;BYDAY=-1FR;UNTIL=20261231T235959Z', 'SUMMARY:Bilan'),
        vevent('UID:d', 'DTSTART;VALUE=DATE:20261012', 'DTEND;VALUE=DATE:20261013', 'SUMMARY:Anniversaire'),
        vevent('UID:c', 'DTSTART:20261012T090000Z', 'STATUS:CANCELLED', 'SUMMARY:Annulé'),
      ),
    );
    const events = eventsBetween(raw, ...range('2026-09-01T00:00:00Z', '2027-03-01T00:00:00Z'));
    const bilans = events.filter((e) => e.title === 'Bilan').map((e) => iso(e.start).slice(0, 10));
    expect(bilans).toEqual(['2026-09-25', '2026-10-30', '2026-11-27', '2026-12-25']);
    const birthday = events.find((e) => e.title === 'Anniversaire')!;
    expect(birthday.allDay).toBe(true);
    expect(birthday.end - birthday.start).toBe(86_400_000);
    expect(events.some((e) => e.title === 'Annulé')).toBe(false);
  });

  it('accepts webcal addresses and several calendars', () => {
    expect(parseCalendarUrls('webcal://p42-caldav.icloud.com/published/2/abc\nhttps://calendar.google.com/x/basic.ics\nnot a url')).toEqual([
      'https://p42-caldav.icloud.com/published/2/abc',
      'https://calendar.google.com/x/basic.ics',
    ]);
  });
});
