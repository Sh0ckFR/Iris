import type { Briefing } from './tools';
import type { Attachment } from './documents';
import { LANGUAGES, uiLanguage, type UiLanguage } from '../../i18n';

/** Types, constants and small helpers shared by the assistant's hooks (see useAssistant.ts). */

export type Phase = 'idle' | 'listening' | 'thinking' | 'speaking';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  brain?: string;
  error?: boolean;
  /** Live data fetched while answering (news, weather…), shown as cards in the HUD. */
  briefings?: Briefing[];
  /** Files sent with this (user) message. */
  attachments?: { name: string; kind: Attachment['kind']; size: number }[];
}

/** One request being worked on. Several can run at the same time. */
export interface Task {
  id: string;
  title: string;
  status: 'running' | 'done' | 'error' | 'cancelled';
  /** What the task is doing right now ("Checking the news…"). */
  activity: string | null;
  source: 'text' | 'voice';
  startedAt: number;
  endedAt?: number;
  /** Conversation messages (question + reply) belonging to this task. */
  messageIds?: string[];
}

/**
 * Conversation summary: once more than SUMMARY_AFTER messages (≈ 10 exchanges) are not covered by
 * the summary, the older ones — all but the last SUMMARY_KEEP — are summarized and no longer sent.
 * HISTORY_LIMIT only caps the uncovered part in the meantime.
 */
export const SUMMARY_AFTER = 20;
export const SUMMARY_KEEP = 6;
export const HISTORY_LIMIT = 30;
/** Messages kept on disk for the next launch (text only). */
export const SAVED_MESSAGES = 80;
/** Finished tasks stay visible in the tray for this long. */
export const FINISHED_TASK_TTL_MS = 6000;
/** With nobody talking to Iris for this long, the cloud session closes (local standby). */
export const HANDS_FREE_IDLE_MS = 30_000;
/** Economy voice: after Iris stops talking, the user can answer without her name for this long. */
export const FOLLOW_UP_MS = 8_000;
/** A spoken request with nothing said yet after this long gets a short local acknowledgement. */
export const ACK_AFTER_MS = 1_200;
/** Tools slow enough to acknowledge as soon as they are called. */
export const SLOW_TOOLS = /^(search_web|read_webpage|get_news|lookup_wikipedia|look_at_screen|use_computer|create_visual|generate_image|show_data|run_command|create_skill|mcp_)/;
/** Exchanges a tool group stays available after it was used (follow-ups). */
export const GROUP_MEMORY = 2;

/**
 * Whether this is a new session (Iris was just opened) rather than a reload of the page: the
 * webview's sessionStorage survives reloads, not the app's restart.
 */
export const isNewSession = (() => {
  try {
    if (sessionStorage.getItem('iris.session')) return false;
    sessionStorage.setItem('iris.session', String(Date.now()));
    return true;
  } catch {
    return true;
  }
})();
/** When this session started (a reload keeps the same one). */
export const SESSION_STARTED_AT = (() => {
  try {
    return Number(sessionStorage.getItem('iris.session')) || Date.now();
  } catch {
    return Date.now();
  }
})();

export const EN_HONORIFIC: Record<string, string> = { monsieur: 'sir', madame: "ma'am", mademoiselle: 'miss' };

let seq = 0;
export const uid = () => `${Date.now().toString(36)}-${(seq++).toString(36)}`;

/** Timers, alerts and scheduled tasks: they wait in the tray without making Iris busy. */
export const isBackgroundTask = (id: string) => /^(timer|alert|sched)-/.test(id);

/** Adds a card to a message, or replaces it (visuals are updated live while they stream). */
export function upsertBriefing(list: Briefing[] | undefined, b: Briefing): Briefing[] {
  return list?.some((x) => x.id === b.id) ? list.map((x) => (x.id === b.id ? b : x)) : [...(list ?? []), b];
}

/**
 * Human label for a tool call run as a (voice) task: in the interface language, or in `lang` for a
 * line Iris says (the conversation's language).
 */
export function toolLabel(name: string, lang: UiLanguage = uiLanguage()): string {
  return LANGUAGES[lang].messages.tools[name] ?? name;
}

export function toolTaskTitle(name: string, args: unknown): string {
  const label = toolLabel(name);
  const values = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  const first = typeof values.title === 'string' && values.title ? values.title : Object.values(values).find((v) => typeof v === 'string' && v);
  return first ? `${label} : ${String(first).slice(0, 40)}` : label;
}

/** "Acme, Zephyr ; Orion" → ["Acme", "Zephyr", "Orion"] */
export function parseVocabulary(raw: string): string[] {
  return [...new Set(raw.split(/[,;\n]/).map((t) => t.trim()).filter((t) => t.length > 1))];
}

/**
 * Startup status line, in a butler's style. Built from real data only (the clock): it is spoken
 * before any model runs, so nothing in it can be hallucinated.
 */
export function greetingText(lang: 'fr' | 'en', honorific: string, now: Date): string {
  const h = now.getHours();
  const m = now.getMinutes();
  const late = h >= 23 || h < 5;
  const hon = honorific.trim();
  if (lang === 'fr') {
    const hello = h >= 5 && h < 18 ? 'Bonjour' : 'Bonsoir';
    const time = `${h} heure${h > 1 ? 's' : ''}${m ? ` ${m}` : ''}`;
    return [
      `${hello}${hon ? `, ${hon}` : ''}.`,
      `Il est ${time}.`,
      'Tous les systèmes sont opérationnels.',
      late ? 'Il se fait tard, si je puis me permettre.' : '',
    ].join(' ');
  }
  const period = h >= 5 && h < 12 ? 'morning' : h >= 12 && h < 18 ? 'afternoon' : 'evening';
  const enHon = hon ? EN_HONORIFIC[hon.toLowerCase()] ?? hon : '';
  const time = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return [
    `Good ${period}${enHon ? `, ${enHon}` : ''}.`,
    `It's ${time}.`,
    'All systems are online.',
    late ? 'It is rather late, if I may say so.' : '',
  ].join(' ');
}

export function micErrorMessage(error: unknown): string {
  const name = error instanceof DOMException ? error.name : '';
  if (name === 'NotAllowedError') return 'Microphone access was denied. Allow it in your system privacy settings.';
  if (name === 'NotFoundError') return 'No microphone was found.';
  return error instanceof Error ? error.message : String(error);
}
