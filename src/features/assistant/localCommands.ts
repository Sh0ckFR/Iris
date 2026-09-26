import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { isAddressedToIris, stripAddress } from './wakeWord';

/**
 * Everyday requests answered on this computer, without calling any AI model (0 token, instant):
 * the time, the date, opening an app, a timer, the volume, "stop talking", "stop listening".
 * Anything else — or anything these patterns aren't sure about — goes to the AI as usual.
 */

export type LocalCommand =
  /** Just her name ("Iris ?"): she answers "Yes?" and listens for the request. */
  | { kind: 'attention' }
  | { kind: 'time' }
  | { kind: 'date' }
  | { kind: 'open_app'; name: string }
  | { kind: 'timer'; seconds: number }
  | { kind: 'volume'; action: 'up' | 'down' | 'mute'; steps: number }
  | { kind: 'stop_talking' }
  | { kind: 'stop_listening' }
  /** Iris's windows: the interface ("main"), the always-on-top mini window, or whichever is on screen. */
  | { kind: 'window'; target: 'main' | 'mini' | 'auto'; action: 'show' | 'hide' | 'move'; position?: string }
  /** A pinned dashboard: "affiche mon écran du matin", "ferme le tableau de bord". */
  | { kind: 'dashboard'; action: 'show' | 'hide'; name?: string };

/** Lower case, no accents, no punctuation, single spaces: "Quelle heure est-il ?" → "quelle heure est il". */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’`]/g, "'")
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const POLITE = "(?: s'il te plait| s'il vous plait| stp| svp| please)?";

const TIME = new RegExp(
  `^(?:quelle heure (?:est il|il est)|il est quelle heure|tu as l'heure|what time is it|what's the time|what is the time|tell me the time)${POLITE}$`,
);
const DATE = new RegExp(
  `^(?:quel jour (?:sommes nous|on est|est on|nous sommes|c'est|est ce)(?: aujourd'hui)?|on est quel jour(?: aujourd'hui)?|c'est quel jour(?: aujourd'hui)?|quelle (?:est la )?date(?: sommes nous| aujourd'hui| on est)?|on est le combien|what(?:'s| is) (?:the )?(?:date|day)(?: today)?|what day is (?:it|today))${POLITE}$`,
);
const STOP_TALKING = /^(?:stop|arrete|arrete toi|tais toi|silence|chut|ca suffit|c'est bon|stop talking|be quiet|shut up|that's enough|enough)$/;
const STOP_LISTENING =
  /(?:arrete|arreter|cesse|stop)(?: d'| de | )ecouter|mets? toi en veille|(?:passe|retourne|reste) en veille|mode veille|stop listening|go to sleep|laisse (?:nous|moi) tranquille/;
const TIMER = /^(?:(?:mets|met|lance|demarre|programme|fais|set|start)(?: moi)? )?(?:un |une |a )?(?:minuteur|timer|compte a rebours|countdown)(?: de| pour| for| of|)? (.+)$/;
const OPEN = /^(?:ouvre|ouvrir|lance|lancer|demarre|open|launch|start)(?: moi| me)? (?:l'application |l'appli |the app |app )?(.+)$/;
/** "affiche-toi", "montre ton interface", "reviens", "show yourself"… */
const SHOW_MAIN =
  /^(?:(?:affiche|montre|ouvre|agrandis|reaffiche)(?: toi| moi ton interface| moi ta fenetre| ton interface| ta fenetre| l'interface)|reviens(?: a l'ecran)?|show (?:yourself|your (?:interface|window)|me your (?:interface|window))|open your (?:interface|window)|come back)$/;
const HIDE_MAIN =
  /^(?:(?:cache|masque|reduis|planque|ferme)(?: toi| ton interface| ta fenetre| l'interface)|hide (?:yourself|your (?:interface|window))|minimi[sz]e (?:yourself|your window))$/;
const MINI = /\b(?:mini fenetre|petite fenetre|mini interface|mini window|small window)\b/;
const MOVE = /^(?:mets|met|place|deplace|bouge|positionne|move|put)\b/;
const SHOW_DASHBOARD =
  /^(?:(?:affiche|montre|ouvre|reaffiche|remets)(?: moi)?|show(?: me)?|open) (?:mon |ma |le |la |l'|my |the )?(?:tableau de bord|dashboard|ecran)(?: (?:du|de la|de|d'|des|for) ?(.+))?$/;
const HIDE_DASHBOARD = /^(?:cache|ferme|masque|enleve|hide|close) (?:mon |le |l'|the |my )?(?:tableau de bord|dashboard)$/;

/** "en haut à gauche" / "top left" / "au centre" → "top-left" / "center" (null if no position). */
export function parsePosition(t: string): string | null {
  const v = /\b(?:haut|top|upper)\b/.test(t) ? 'top' : /\b(?:bas|bottom|lower)\b/.test(t) ? 'bottom' : '';
  const h = /\b(?:gauche|left)\b/.test(t) ? 'left' : /\b(?:droite|right)\b/.test(t) ? 'right' : '';
  if (v || h) return [v, h].filter(Boolean).join('-');
  return /\b(?:centre|milieu|center|middle)\b/.test(t) ? 'center' : null;
}

/** Words meaning the request is about a site, file or search: the AI handles those. */
const NOT_AN_APP = /\b(?:site|page|fichier|dossier|file|folder|document|onglet|tab|lien|link|url|video|recherche|search|photo|image|mail|e mail|email|playlist|chanson|song|musique|music|film|movie)\b/;

const NUMBERS: Record<string, number> = {
  un: 1, une: 1, one: 1, a: 1, an: 1, deux: 2, two: 2, trois: 3, three: 3, quatre: 4, four: 4, cinq: 5, five: 5,
  six: 6, sept: 7, seven: 7, huit: 8, eight: 8, neuf: 9, nine: 9, dix: 10, ten: 10, quinze: 15, fifteen: 15,
  vingt: 20, twenty: 20, trente: 30, thirty: 30, quarante: 40, forty: 40, soixante: 60, sixty: 60,
};

/** "10 minutes", "une heure et demie", "90 secondes", "2 h 30", "1h30" → seconds (null if unclear). */
export function parseDuration(text: string): number | null {
  const words = normalize(text)
    .replace(/'/g, ' ')
    .replace(/(\d)([a-z])/g, '$1 $2')
    .replace(/([a-z])(\d)/g, '$1 $2')
    .split(' ');
  let total = 0;
  let found = false;
  let previousUnit = 0;
  for (let i = 0; i < words.length; i++) {
    const value = /^\d+$/.test(words[i]) ? Number(words[i]) : NUMBERS[words[i]];
    if (value === undefined) continue;
    const unit = words[i + 1] ?? '';
    let size = /^(?:h|heures?|hours?|hrs?)$/.test(unit) ? 3600 : /^(?:min|mins|minutes?)$/.test(unit) ? 60 : /^(?:s|sec|secs|secondes?|seconds?)$/.test(unit) ? 1 : 0;
    // "2 h 30": a bare number right after hours means minutes.
    if (!size && previousUnit === 3600 && /^\d+$/.test(words[i])) size = 60;
    if (!size) continue;
    previousUnit = size;
    total += value * size;
    found = true;
    // "et demie" / "and a half"
    if (/^(?:et|and)$/.test(words[i + 2] ?? '') && /^(?:demie?|half)$/.test(words[i + 3] === 'a' ? words[i + 4] ?? '' : words[i + 3] ?? '')) {
      total += size / 2;
    }
  }
  return found && total > 0 && total <= 24 * 3600 ? total : null;
}

/** The local command a request is, if it is clearly one. `text` may still address Iris by name. */
export function matchLocalCommand(text: string): LocalCommand | null {
  const t = normalize(stripAddress(text));
  if (!t) return isAddressedToIris(text) ? { kind: 'attention' } : null;
  if (STOP_TALKING.test(t)) return { kind: 'stop_talking' };
  if (STOP_LISTENING.test(t)) return { kind: 'stop_listening' };
  if (SHOW_MAIN.test(t)) return { kind: 'window', target: 'main', action: 'show' };
  if (HIDE_MAIN.test(t)) return { kind: 'window', target: 'main', action: 'hide' };
  if (MINI.test(t) && t.split(' ').length <= 8) {
    if (/\b(?:cache|masque|ferme|enleve|hide|close)\b/.test(t)) return { kind: 'window', target: 'mini', action: 'hide' };
    if (/\b(?:affiche|montre|reaffiche|remets|show)\b/.test(t)) return { kind: 'window', target: 'mini', action: 'show' };
  }
  if (MOVE.test(t) && t.split(' ').length <= 10) {
    const position = parsePosition(t);
    // "mets-toi en haut", "déplace la mini fenêtre à droite", "move your window to the top left"
    if (position && /\b(?:toi|yourself|fenetre|window|interface)\b/.test(t)) {
      return { kind: 'window', target: MINI.test(t) ? 'mini' : 'auto', action: 'move', position };
    }
  }
  const dashboard = SHOW_DASHBOARD.exec(t);
  if (dashboard) return { kind: 'dashboard', action: 'show', name: dashboard[1] };
  if (HIDE_DASHBOARD.test(t)) return { kind: 'dashboard', action: 'hide' };
  if (TIME.test(t)) return { kind: 'time' };
  if (DATE.test(t)) return { kind: 'date' };

  const timer = TIMER.exec(t);
  if (timer) {
    const seconds = parseDuration(timer[1]);
    return seconds ? { kind: 'timer', seconds } : null;
  }

  if (/\b(?:son|volume|sound|sourdine|mute|unmute|plus fort|moins fort|louder|quieter)\b/.test(t) && t.split(' ').length <= 8) {
    const steps = /\b(?:un peu|a bit|a little|legerement)\b/.test(t) ? 3 : /\b(?:beaucoup|a lot|much)\b/.test(t) ? 10 : 5;
    if (/\b(?:coupe|mute|sourdine|unmute|remets|reactive|retablis)\b/.test(t)) return { kind: 'volume', action: 'mute', steps: 1 };
    if (/\b(?:monte|augmente|hausse|plus fort|louder|up)\b/.test(t)) return { kind: 'volume', action: 'up', steps };
    if (/\b(?:baisse|diminue|moins fort|quieter|down|lower)\b/.test(t)) return { kind: 'volume', action: 'down', steps };
  }

  const open = OPEN.exec(t);
  if (open) {
    const name = open[1].replace(/^(?:le |la |les |l'|un |une |mon |ma |mes |the |my )/, '').trim();
    if (name && !NOT_AN_APP.test(name) && !/[./:]/.test(name) && name.split(' ').length <= 3) return { kind: 'open_app', name };
  }
  return null;
}

// ---------------------------------------------------------------- spoken replies

export function formatDuration(seconds: number, lang: 'fr' | 'en'): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const part = (n: number, fr: string, en: string) => (n ? `${n} ${lang === 'fr' ? fr : en}${n > 1 ? 's' : ''}` : '');
  return [part(h, 'heure', 'hour'), part(m, 'minute', 'minute'), part(s, 'seconde', 'second')].filter(Boolean).join(' ');
}

export function timeReply(lang: 'fr' | 'en', now = new Date()): string {
  if (lang === 'en') return `It's ${now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}.`;
  const h = now.getHours();
  const m = now.getMinutes();
  const hour = h === 0 ? 'minuit' : h === 12 ? 'midi' : `${h} heure${h > 1 ? 's' : ''}`;
  return `Il est ${hour}${m ? ` ${m}` : ''}.`;
}

export function dateReply(lang: 'fr' | 'en', now = new Date()): string {
  const options: Intl.DateTimeFormatOptions = { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' };
  return lang === 'fr' ? `Nous sommes le ${now.toLocaleDateString('fr-FR', options)}.` : `Today is ${now.toLocaleDateString('en-US', options)}.`;
}

// ---------------------------------------------------------------- timer tool (for the AI)

/**
 * set_timer: timers and short reminders ("rappelle-moi dans 10 minutes de sortir le gâteau").
 * `start` runs the countdown in the HUD and announces the end.
 */
export function createTimerTools(start: (seconds: number, label?: string) => string): ToolSet {
  return {
    set_timer: tool({
      description:
        'Start a timer or a short reminder: when it ends, Iris rings and says so aloud (with the label, e.g. "sortir le gâteau"). The timer is shown in the task tray and can be cancelled there.',
      inputSchema: z.object({
        seconds: z.number().int().min(1).max(86_400).describe('Duration in seconds'),
        label: z.string().optional().describe("What it is for, in the user's language (optional)"),
      }),
      execute: async ({ seconds, label }) => ({ started: true, endsAt: start(seconds, label) }),
    }),
  };
}
