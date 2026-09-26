import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { describeWhen, nextOccurrence, parseWhen, scheduleStore, type Scheduled, type ScheduleAction } from './schedule';

/** schedule_task / cancel_schedule: the model's access to the scheduler (see schedule.ts). */
export function createScheduleTools(hooks: { onAdded: (entry: Scheduled) => void; onRemoved: (id: string) => void }, fr: boolean): ToolSet {
  return {
    schedule_task: tool({
      description:
        'Do something later or regularly, even after a restart: a reminder at a given time ("rappelle-moi à 17 h d\'appeler Claire"), a request run for the user ("chaque lundi à 9 h, fais-moi un résumé des marchés"), or a pinned dashboard shown ("chaque matin à 8 h, affiche mon écran du matin et fais-moi un point"). For a countdown ("dans 10 minutes") use set_timer instead.',
      inputSchema: z.object({
        mode: z.enum(['remind', 'ask', 'dashboard']).describe('remind: say the text; ask: run the request as if the user said it (answered aloud); dashboard: show a pinned dashboard, then optionally run the request'),
        what: z.string().describe('remind: the reminder, in the user\'s words ("appeler Claire"); ask / dashboard: the request to run ("Fais-moi le point du matin : météo à Lyon, actualités, marchés")'),
        at: z.string().describe('A time "HH:MM" (today, or tomorrow if passed; with days: every time), or a local date-time "YYYY-MM-DDTHH:MM" for another day'),
        days: z.array(z.string()).optional().describe('To repeat: "daily", "weekdays", "weekends", or days such as ["mon", "thu"]'),
        dashboard: z.string().optional().describe('dashboard mode: the dashboard\'s name (e.g. "Écran du matin")'),
        label: z.string().optional().describe('Short name for the task tray, e.g. "Point du matin"'),
      }),
      execute: async ({ mode, what, at, days, dashboard, label }) => {
        await scheduleStore.load();
        const when = parseWhen(at, days);
        if (!when) return { scheduled: false, note: 'This time could not be read: give "HH:MM", or "YYYY-MM-DDTHH:MM" in the future.' };
        const nextAt = nextOccurrence(when, new Date());
        if (!nextAt) return { scheduled: false, note: 'This time is in the past.' };
        const action: ScheduleAction =
          mode === 'remind' ? { kind: 'remind', text: what } : mode === 'dashboard' ? { kind: 'dashboard', name: dashboard ?? what, prompt: dashboard ? what : undefined } : { kind: 'ask', prompt: what };
        const entry: Scheduled = { id: `sc-${Date.now().toString(36)}`, label: label?.trim() || what.slice(0, 50), when, action, nextAt, createdAt: Date.now() };
        scheduleStore.add(entry);
        hooks.onAdded(entry);
        return { scheduled: entry.label, when: describeWhen(when, fr), note: 'Confirm in one short sentence.' };
      },
    }),

    cancel_schedule: tool({
      description: 'Cancel scheduled tasks and reminders ("annule le point du matin", "supprime mes rappels"), or list them (what = "list").',
      inputSchema: z.object({ what: z.string().describe('Words of the task to cancel, "all", or "list"') }),
      execute: async ({ what }) => {
        await scheduleStore.load();
        const all = scheduleStore.list();
        const describe = (e: Scheduled) => `${e.label} — ${describeWhen(e.when, fr)}`;
        if (/^(list|liste)$/i.test(what.trim())) return { scheduled: all.map(describe) };
        const words = what.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
        const removed = /^(all|tout|toutes?|tous)$/i.test(what.trim())
          ? all
          : all.filter((e) => words.some((w) => `${e.label} ${JSON.stringify(e.action)}`.toLowerCase().includes(w)));
        removed.forEach((e) => {
          scheduleStore.remove(e.id);
          hooks.onRemoved(e.id);
        });
        return { cancelled: removed.map(describe), remaining: scheduleStore.list().map(describe) };
      },
    }),
  };
}
