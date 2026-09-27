import { describe, expect, it } from 'vitest';
import { eventSignals, inQuietHours, mailSignals, morningSignal, parseDailyMemory, pickSignal, type Signal } from './proactive';

const hon = { fr: 'Monsieur', en: 'sir' };
const at = (h: number, m = 0) => new Date(2026, 8, 28, h, m);

describe('proactivity', () => {
  it('respects quiet hours, across midnight too', () => {
    expect(inQuietHours(at(23), 22, 7)).toBe(true);
    expect(inQuietHours(at(3), 22, 7)).toBe(true);
    expect(inQuietHours(at(7), 22, 7)).toBe(false);
    expect(inQuietHours(at(13), 12, 14)).toBe(true);
    expect(inQuietHours(at(13), 0, 0)).toBe(false);
  });

  it('announces meetings 3 to 20 minutes ahead, not all-day events', () => {
    const now = at(9, 50).getTime();
    const events = [
      { uid: 'a', title: 'Point produit', start: at(10).getTime(), end: at(11).getTime(), allDay: false, location: 'Salle 2' },
      { uid: 'b', title: 'Trop tard', start: at(9, 52).getTime(), end: at(10).getTime(), allDay: false },
      { uid: 'c', title: 'Plus tard', start: at(11).getTime(), end: at(12).getTime(), allDay: false },
      { uid: 'd', title: 'Congés', start: at(0).getTime(), end: at(23).getTime(), allDay: true },
    ];
    const signals = eventSignals(events, now, hon);
    expect(signals.map((s) => s.line?.fr)).toEqual(['Monsieur, « Point produit » commence dans 10 minutes (Salle 2).']);
    expect(signals[0].expires).toBe(at(10).getTime());
  });

  it('singles out e-mails from people who matter, and groups the rest', () => {
    const mail = (uid: number, from: string, subject: string) => ({ uid, from, address: `${from.split(' ')[0].toLowerCase()}@x.fr`, subject, date: null });
    const now = at(10).getTime();
    const first = mailSignals([mail(1, 'Claire Martin', 'Devis'), mail(2, 'Newsletter', 'Promos'), mail(3, 'Bob', 'URGENT : facture')], ['Claire Martin', 'Lyon'], 0, now, hon);
    expect(first.signals.map((s) => s.priority)).toEqual([70, 60]); // Claire (known), then the urgent one
    expect(first.ordinary).toBe(1);
    const later = mailSignals([2, 3, 4, 5].map((n) => mail(10 + n, 'Shop', 'Offre')), [], first.ordinary, now, hon);
    expect(later.signals).toHaveLength(1);
    expect(later.signals[0].line?.fr).toContain('5 nouveaux e-mails');
    expect(later.ordinary).toBe(0);
  });

  it('offers the morning briefing once, in the morning only', () => {
    expect(morningSignal(at(8), hon)?.line?.fr).toBe('Bonjour Monsieur. Voulez-vous le point du matin ?');
    expect(morningSignal(at(12), hon)).toBeNull();
    expect(morningSignal(at(5), hon)).toBeNull();
  });

  it('picks the most important signal, spacing them out', () => {
    const now = at(10).getTime();
    const s = (key: string, kind: Signal['kind'], priority: number): Signal => ({ key, kind, priority, line: { fr: key, en: key }, expires: now + 60_000 });
    const all = [s('rain', 'rain', 50), s('meeting', 'event', 90), s('said', 'memory', 95)];
    const base = { now, lastSpokeAt: 0, today: 0, delivered: new Set(['said']) };
    expect(pickSignal(all, base)?.key).toBe('meeting');
    // Just spoke: only a meeting reminder may follow closely.
    expect(pickSignal(all, { ...base, lastSpokeAt: now - 2 * 60_000 })?.key).toBe('meeting');
    expect(pickSignal([s('rain', 'rain', 50)], { ...base, lastSpokeAt: now - 2 * 60_000 })).toBeNull();
    expect(pickSignal(all, { ...base, today: 12 })).toBeNull();
  });

  it("reads the day's memory check", () => {
    expect(parseDailyMemory('```json\n[{"text": "C\'est l\'anniversaire de Julie demain. Voulez-vous un rappel ?"}]\n```')).toEqual([
      "C'est l'anniversaire de Julie demain. Voulez-vous un rappel ?",
    ]);
    expect(parseDailyMemory('[]')).toEqual([]);
    expect(parseDailyMemory('nothing today')).toEqual([]);
  });
});
