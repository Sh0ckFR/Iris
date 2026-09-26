import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import type { Language } from '../../lib/settings';
import { alertStore, describeAlert, isMet, readAlert, type Alert } from './alerts';
import { resolveLang } from './tools';

/** set_alert / cancel_alert: the model's access to the live-data alerts (see alerts.ts). */
export function createAlertTools(hooks: { onAdded: (alert: Alert) => void; onRemoved: (id: string) => void }, defaultLanguage: Language): ToolSet {
  return {
    set_alert: tool({
      description:
        'Watch a live figure and tell the user when a condition is met ("préviens-moi si le bitcoin passe sous 80 000", "si l\'indice dépasse 8 200", "s\'il pleut à Lyon", "si mon action bouge de 3 %"). It is checked on this computer every minute (quotes) or 10 minutes (weather), for free, and fires once, even after a restart.',
      inputSchema: z.object({
        watch: z.enum(['quote', 'weather']).describe('quote: a share, index, crypto or currency pair; weather: a city'),
        query: z.string().describe('What to watch, e.g. "bitcoin", "EUR USD", "Lyon"'),
        condition: z
          .enum(['above', 'below', 'move', 'rain', 'temp_above', 'temp_below', 'wind_above'])
          .describe('above / below a price; move = changes by threshold % from now; rain; temp_above / temp_below (°C); wind_above (km/h)'),
        threshold: z.number().optional().describe('The price, %, °C or km/h (none for rain)'),
        language: z.string().optional(),
      }),
      execute: async ({ watch, query, condition, threshold, language }) => {
        const lang = resolveLang(language, defaultLanguage);
        const alert: Alert = { id: `al-${Date.now().toString(36)}`, source: watch, query, op: condition, threshold, createdAt: Date.now() };
        const now = await readAlert(alert, lang);
        const current = `${now.value.toLocaleString(lang)} ${now.unit}${now.label ? ` (${now.label})` : ''}`;
        if (condition === 'move') alert.base = now.value;
        // Already true: say so instead of an alert that would fire at once.
        if (isMet(alert, now)) return { set: false, alreadyMet: true, current, note: 'The condition is already met: tell the user.' };
        alert.last = `${now.value.toLocaleString(lang)} ${now.unit}`;
        alert.lastCheck = Date.now();
        alertStore.add(alert);
        hooks.onAdded(alert);
        return { set: true, watching: describeAlert(alert, lang === 'fr'), current, checked: watch === 'quote' ? 'every minute' : 'every 10 minutes' };
      },
    }),

    cancel_alert: tool({
      description: 'Cancel alerts set with set_alert ("annule l\'alerte sur le bitcoin", "supprime toutes les alertes"), or list them (what = "list").',
      inputSchema: z.object({ what: z.string().describe('Words of the alert to cancel, "all", or "list"') }),
      execute: async ({ what }) => {
        await alertStore.load();
        const all = alertStore.list();
        const describe = (a: Alert) => describeAlert(a, true);
        if (/^(list|liste)$/i.test(what.trim())) return { alerts: all.map(describe) };
        const words = what.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
        const removed = /^(all|toutes?|tout)$/i.test(what.trim())
          ? all
          : all.filter((a) => words.some((w) => `${a.query} ${a.name ?? ''}`.toLowerCase().includes(w)));
        removed.forEach((a) => {
          alertStore.remove(a.id);
          hooks.onRemoved(a.id);
        });
        return { cancelled: removed.map(describe), remaining: alertStore.list().map(describe) };
      },
    }),
  };
}
