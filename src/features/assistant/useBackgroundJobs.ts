import { useCallback, useEffect, useRef, type MutableRefObject } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { Settings } from '../../lib/settings';
import { costStore, formatMoney, refreshEuroRate } from '../../lib/costs';
import { dashboardStore, findDashboard } from '../../lib/dashboards';
import { alertStore, describeAlert, firedLine, watchAlerts, type Alert } from './alerts';
import { describeWhen, LATE_MS, nextOccurrence, scheduleStore, TOO_LATE_MS, type Scheduled } from './schedule';
import { formatDuration } from './localCommands';
import { playSfx } from './sfx';
import { uid, type Task } from './assistantShared';

/**
 * What runs in the background, besides the conversation — each in the task tray, and spoken when
 * it's time: timers (kept across restarts), alerts on live data, scheduled tasks (reminders,
 * requests, dashboards at a given time or every week), and the daily budget warning. When the
 * user is busy at the time of a scheduled request, Iris asks first ("Puis-je vous
 * interrompre ?", answered by voice or on the card).
 */

interface Options {
  live: MutableRefObject<{ settings: Settings; tasks: Task[] }>;
  controllers: MutableRefObject<Map<string, AbortController>>;
  addTask: (task: Omit<Task, 'status' | 'activity' | 'startedAt'>) => void;
  patchTask: (id: string, patch: Partial<Task>) => void;
  finishTask: (id: string, status: Task['status']) => void;
  addLocalReply: (content: string) => void;
  say: (text: string, channel: string) => Promise<void>;
  replyLang: () => 'fr' | 'en';
  honorific: (lang: 'fr' | 'en') => string;
  setNotice: (text: string | null) => void;
  /** Runs a request as if the user had just said it (scheduled "ask" tasks). */
  runRequest: MutableRefObject<(text: string) => void>;
  /** The user is in the middle of something (a request, Iris talking, just spoke). */
  isBusy: () => boolean;
  /** "May I interrupt?" — asked aloud and on a card; resolves with the answer. */
  askToInterrupt: (taskId: string, label: string) => Promise<boolean>;
}

/** A timer as kept on disk, so it survives a restart. */
interface SavedTimer {
  id: string;
  endsAt: number;
  seconds: number;
  label?: string;
  source: Task['source'];
}

const TIMERS_FILE = 'timers';
let savedTimers: SavedTimer[] = [];
/** Once per app session (effects run twice in development). */
let timersRestored = false;
const saveTimers = () =>
  invoke('memory_write', { name: TIMERS_FILE, content: JSON.stringify(savedTimers) }).catch((error) => console.warn('[iris:timers] could not save', error));

export function useBackgroundJobs(o: Options) {
  const { live, controllers, addTask, patchTask, finishTask, addLocalReply, say, replyLang, honorific, setNotice } = o;
  // The scheduler's loop is set up once: it reads the latest options through this ref.
  const latest = useRef(o);
  latest.current = o;
  /** "Monsieur, " / "" in front of a line Iris says on her own. */
  const hon = (lang: 'fr' | 'en') => {
    const h = honorific(lang);
    return h ? `${h}, ` : '';
  };

  // ------------------------------------------------------------------ timers

  /** Shows a timer in the tray and rings when it ends (a new one, or one restored at launch). */
  const armTimer = useCallback(
    (timer: SavedTimer) => {
      const lang = replyLang();
      const fr = lang === 'fr';
      const duration = formatDuration(timer.seconds, lang);
      const clock = new Date(timer.endsAt).toLocaleTimeString(navigator.language, { hour: '2-digit', minute: '2-digit', ...(timer.seconds < 3600 && { second: '2-digit' }) });
      addTask({ id: timer.id, title: `${fr ? 'Minuteur' : 'Timer'} ${duration}${timer.label ? ` — ${timer.label}` : ''}`, source: timer.source });
      patchTask(timer.id, { activity: `${fr ? 'fin à' : 'ends at'} ${clock}` });
      const controller = new AbortController();
      controllers.current.set(timer.id, controller);
      const forget = () => {
        savedTimers = savedTimers.filter((t) => t.id !== timer.id);
        void saveTimers();
      };
      const handle = window.setTimeout(() => {
        forget();
        finishTask(timer.id, 'done');
        playSfx('alert');
        const h = hon(lang);
        const line = fr
          ? `${h ? `${h}votre` : 'Votre'} minuteur de ${duration} est terminé${timer.label ? ` : ${timer.label}` : ''}.`
          : `${h ? `${h}your` : 'Your'} ${duration} timer is done${timer.label ? `: ${timer.label}` : ''}.`;
        addLocalReply(line);
        void say(line, timer.id);
      }, Math.max(0, timer.endsAt - Date.now()));
      controller.signal.addEventListener('abort', () => {
        window.clearTimeout(handle);
        forget();
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [addTask, patchTask, finishTask, addLocalReply, say],
  );

  /**
   * Timer / reminder in a few minutes: a task in the tray (cancellable there) that rings and
   * speaks when it ends, even after a restart. Returns the end time, for the model.
   */
  const startTimer = useCallback(
    (seconds: number, label: string | undefined, source: Task['source']): string => {
      const timer: SavedTimer = { id: `timer-${uid()}`, endsAt: Date.now() + seconds * 1000, seconds, label, source };
      savedTimers = [...savedTimers, timer];
      void saveTimers();
      armTimer(timer);
      return new Date(timer.endsAt).toLocaleString(navigator.language);
    },
    [armTimer],
  );

  // Timers of the previous session: those still running go on; those that ended meanwhile are told.
  useEffect(() => {
    if (timersRestored) return;
    timersRestored = true;
    void invoke<string | null>('memory_read', { name: TIMERS_FILE })
      .then((raw) => {
        const list = raw ? (JSON.parse(raw) as SavedTimer[]) : [];
        const now = Date.now();
        savedTimers = list.filter((t) => t.endsAt > now);
        if (savedTimers.length !== list.length) void saveTimers();
        savedTimers.forEach(armTimer);
        const missed = list.filter((t) => t.endsAt <= now && now - t.endsAt < TOO_LATE_MS);
        for (const t of missed) {
          const lang = replyLang();
          const at = new Date(t.endsAt).toLocaleTimeString(navigator.language, { hour: '2-digit', minute: '2-digit' });
          addLocalReply(
            lang === 'fr'
              ? `Pendant mon absence, votre minuteur de ${formatDuration(t.seconds, lang)}${t.label ? ` (${t.label})` : ''} s'est terminé, à ${at}.`
              : `While I was closed, your ${formatDuration(t.seconds, lang)} timer${t.label ? ` (${t.label})` : ''} ended, at ${at}.`,
          );
        }
      })
      .catch((error) => console.warn('[iris:timers] could not read', error));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ------------------------------------------------------------------ alerts on live data

  /**
   * An alert on live data (alerts.ts) shown as a task in the tray: it shows the last reading and
   * cancelling the task cancels the alert.
   */
  const trackAlert = useCallback(
    (alert: Alert) => {
      const id = `alert-${alert.id}`;
      if (live.current.tasks.some((t) => t.id === id && t.status === 'running')) return;
      const fr = replyLang() === 'fr';
      addTask({ id, title: `🔔 ${describeAlert(alert, fr)}`, source: 'voice' });
      if (alert.last) patchTask(id, { activity: `${fr ? 'actuellement' : 'now'} ${alert.last}` });
      const controller = new AbortController();
      controllers.current.set(id, controller);
      controller.signal.addEventListener('abort', () => alertStore.remove(alert.id));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [addTask, patchTask],
  );

  // Alerts are watched in the background from launch (and survive restarts); Iris speaks when one fires.
  useEffect(() => {
    void alertStore.load().then(() => alertStore.list().forEach(trackAlert));
    return watchAlerts(
      () => replyLang(),
      (alert, reading) => {
        const lang = replyLang();
        finishTask(`alert-${alert.id}`, 'done');
        playSfx('alert');
        const line = firedLine(alert, reading, lang === 'fr', honorific(lang));
        addLocalReply(line);
        void say(line, `alert-${alert.id}`);
      },
      (alert) => patchTask(`alert-${alert.id}`, { activity: `${replyLang() === 'fr' ? 'actuellement' : 'now'} ${alert.last ?? ''}` }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ------------------------------------------------------------------ scheduled tasks

  /** A scheduled task in the tray, with its next time; cancelling the task cancels it. */
  const trackScheduled = useCallback(
    (entry: Scheduled) => {
      const id = `sched-${entry.id}`;
      const fr = replyLang() === 'fr';
      const next = describeWhen(entry.when, fr);
      if (!live.current.tasks.some((t) => t.id === id && t.status === 'running')) {
        addTask({ id, title: `🗓 ${entry.label}`, source: 'voice' });
        const controller = new AbortController();
        controllers.current.set(id, controller);
        controller.signal.addEventListener('abort', () => scheduleStore.remove(entry.id));
      }
      patchTask(id, { activity: next });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [addTask, patchTask],
  );

  /** Does what a scheduled task says (`late`: it was due while Iris was closed). */
  const runScheduled = async (entry: Scheduled, late: boolean) => {
    const lang = replyLang();
    const fr = lang === 'fr';
    const planned = new Date(entry.nextAt).toLocaleTimeString(navigator.language, { hour: '2-digit', minute: '2-digit' });
    const lateNote = late ? (fr ? ` (prévu à ${planned})` : ` (due at ${planned})`) : '';
    const { action } = entry;
    if (action.kind === 'remind') {
      playSfx('alert');
      const line = fr ? `${hon(lang)}rappel${lateNote} : ${action.text}.` : `${hon(lang)}reminder${lateNote}: ${action.text}.`;
      addLocalReply(line);
      void say(line, `sched-${entry.id}`);
      return;
    }
    // A request (or a dashboard): if the user is busy, Iris asks before interrupting.
    const { isBusy, askToInterrupt, runRequest } = latest.current;
    if (isBusy() && !(await askToInterrupt(`sched-${entry.id}`, entry.label))) return;
    if (action.kind === 'dashboard') {
      await dashboardStore.load();
      const d = findDashboard(action.name);
      if (d) dashboardStore.open(d.id);
      if (!action.prompt) {
        const line = d ? (fr ? `${hon(lang)}voici « ${d.name} ».` : `${hon(lang)}here is "${d.name}".`) : fr ? `Je ne trouve pas le tableau de bord « ${action.name} ».` : `I can't find the "${action.name}" dashboard.`;
        addLocalReply(line);
        void say(line, `sched-${entry.id}`);
        return;
      }
    }
    if (action.prompt) runRequest.current(`🗓 ${action.prompt}`);
  };

  // The scheduler: every 15 s, what is due runs; a repeating task then waits for its next time.
  useEffect(() => {
    let alive = true;
    const tick = () => {
      const now = Date.now();
      for (const entry of [...scheduleStore.list()]) {
        if (entry.nextAt > now) continue;
        const lateBy = now - entry.nextAt;
        const repeat = entry.when.kind === 'repeat';
        // Missed long ago while Iris was closed: a repeating task waits for its next time, a
        // one-off still runs (saying so) unless it is really stale.
        const skip = (repeat && lateBy > LATE_MS) || (!repeat && lateBy > TOO_LATE_MS);
        if (!skip) void runScheduled(entry, lateBy > LATE_MS);
        const next = repeat ? nextOccurrence(entry.when, new Date(now + 1000)) : null;
        if (next) {
          const updated = { ...entry, nextAt: next, lastRunAt: skip ? entry.lastRunAt : now };
          scheduleStore.update(updated);
          trackScheduled(updated);
        } else {
          scheduleStore.remove(entry.id);
          finishTask(`sched-${entry.id}`, 'done');
        }
      }
    };
    void scheduleStore.load().then(() => {
      if (!alive) return;
      scheduleStore.list().forEach(trackScheduled);
      tick();
    });
    const timer = window.setInterval(tick, 15_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ------------------------------------------------------------------ costs

  // Prices from Settings, the euro rate once a day, and one spoken warning per day past the budget.
  const { prices, realtimeModel } = live.current.settings;
  useEffect(() => costStore.configure(prices, realtimeModel), [prices, realtimeModel]);
  useEffect(() => {
    void refreshEuroRate();
    return costStore.subscribe(() => {
      const { dailyBudgetEur } = live.current.settings;
      const { today, eurPerUsd } = costStore.summary();
      if (!dailyBudgetEur || !today || !eurPerUsd || today.usd * eurPerUsd < dailyBudgetEur) return;
      try {
        if (localStorage.getItem('iris.budget.warned') === today.day) return;
        localStorage.setItem('iris.budget.warned', today.day);
      } catch {
        // warned again next time: acceptable
      }
      const lang = replyLang();
      const spent = formatMoney(today.usd, eurPerUsd);
      const line =
        lang === 'fr'
          ? `${hon(lang)}le budget du jour est atteint : ${spent} dépensés, pour ${dailyBudgetEur} € prévus.`
          : `${hon(lang)}today's budget is reached: ${spent} spent, of ${dailyBudgetEur} € planned.`;
      playSfx('alert');
      setNotice(line);
      addLocalReply(line);
      void say(line, 'budget');
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { startTimer, trackAlert, trackScheduled };
}
