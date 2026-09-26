import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));
const { describeWhen, nextOccurrence, parseDays, parseWhen } = await import('./schedule');

// Friday 25 September 2026, 10:00 (local time).
const now = new Date(2026, 8, 25, 10, 0, 0);

describe('when scheduled things run', () => {
  it('a time alone is today, or tomorrow once passed', () => {
    const later = parseWhen('17:00', undefined, now)!;
    expect(later.kind).toBe('once');
    expect(new Date((later as { at: number }).at).getHours()).toBe(17);
    const passed = parseWhen('8h', undefined, now) as { at: number };
    expect(new Date(passed.at).getDate()).toBe(26);
  });

  it('a date is that moment; the past is refused', () => {
    expect(parseWhen('2026-09-26T09:30', undefined, now)).toMatchObject({ kind: 'once' });
    expect(parseWhen('2026-09-20T09:30', undefined, now)).toBeNull();
    expect(parseWhen('demain', undefined, now)).toBeNull();
  });

  it('days make it repeat, at the next matching day', () => {
    const everyMorning = parseWhen('08:00', 'daily', now)!;
    expect(everyMorning).toEqual({ kind: 'repeat', time: '8:00', days: [0, 1, 2, 3, 4, 5, 6] });
    expect(new Date(nextOccurrence(everyMorning, now)!).toDateString()).toBe(new Date(2026, 8, 26).toDateString()); // tomorrow 8:00
    const mondays = parseWhen('9:00', ['mon'], now)!;
    const next = new Date(nextOccurrence(mondays, now)!);
    expect([next.getDay(), next.getDate(), next.getHours()]).toEqual([1, 28, 9]); // Monday 28, 9:00
  });

  it('reads day names and groups', () => {
    expect(parseDays(['monday', 'wed'])).toEqual([1, 3]);
    expect(parseDays('weekdays')).toEqual([1, 2, 3, 4, 5]);
    expect(parseDays(['lun', 'ven'])).toEqual([1, 5]);
  });

  it('says when, for the tray', () => {
    expect(describeWhen({ kind: 'repeat', time: '8:00', days: [0, 1, 2, 3, 4, 5, 6] }, true)).toBe('tous les jours à 8:00');
    expect(describeWhen({ kind: 'repeat', time: '9:00', days: [1, 2, 3, 4, 5] }, true)).toBe('en semaine à 9:00');
    expect(describeWhen({ kind: 'once', at: new Date(2026, 8, 25, 17, 0).getTime() }, true, now)).toBe("aujourd'hui à 17:00");
  });
});
