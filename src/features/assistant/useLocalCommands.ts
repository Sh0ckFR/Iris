import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { Settings } from '../../lib/settings';
import { recordLocalAnswer } from '../../lib/usage';
import { dashboardStore, findDashboard } from '../../lib/dashboards';
import { dateReply, formatDuration, timeReply, type LocalCommand } from './localCommands';
import { uid, type ChatMessage, type Task } from './assistantShared';

/**
 * Requests this computer answers by itself (see localCommands.ts): the time, a timer, the volume,
 * windows, dashboards, "stop", standby… 0 token, instant.
 */

interface Options {
  live: MutableRefObject<{ settings: Settings }>;
  replyLang: (text?: string) => 'fr' | 'en';
  honorific: (lang: 'fr' | 'en') => string;
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  addLocalReply: (content: string) => void;
  say: (text: string, channel: string) => Promise<void>;
  startTimer: (seconds: number, label: string | undefined, source: Task['source']) => string;
  /** "Stop talking". */
  stopSpeaking: () => void;
  /** "Stop listening": back to standby (and closes the premium voice session). */
  standBy: () => void;
}

export function useLocalCommands({ live, replyLang, honorific, setMessages, addLocalReply, say, startTimer, stopSpeaking, standBy }: Options) {
  /**
   * Runs a request this computer can answer by itself. Returns false when it can't after all
   * (e.g. no such app): the request then goes to the AI.
   */
  return useCallback(
    async (command: LocalCommand, text: string, source: Task['source']): Promise<boolean> => {
      const { settings: s } = live.current;
      const lang = replyLang(text);
      const fr = lang === 'fr';
      let reply = '';
      switch (command.kind) {
        case 'stop_talking':
          stopSpeaking();
          recordLocalAnswer('stop talking');
          return true;
        case 'attention': {
          const hon = honorific(lang);
          reply = fr ? `Oui${hon ? `, ${hon.toLowerCase()}` : ''} ?` : `Yes${hon ? `, ${hon}` : ''}?`;
          break;
        }
        case 'stop_listening':
          standBy();
          reply = fr ? 'Très bien, je reste en veille.' : "Very well, I'll be on standby.";
          break;
        case 'time':
          reply = timeReply(lang);
          break;
        case 'date':
          reply = dateReply(lang);
          break;
        case 'timer':
          startTimer(command.seconds, undefined, source);
          reply = fr ? `Minuteur de ${formatDuration(command.seconds, lang)} lancé.` : `${formatDuration(command.seconds, lang)} timer started.`;
          break;
        case 'volume':
          try {
            await invoke<string>('os_volume', { action: command.action, steps: command.steps });
          } catch {
            return false;
          }
          reply = command.action === 'mute' ? (fr ? 'Son coupé ou rétabli.' : 'Mute toggled.') : fr ? 'Volume réglé.' : 'Volume adjusted.';
          break;
        case 'window':
          try {
            await invoke<string>('window_control', { target: command.target, action: command.action, position: command.position ?? null });
          } catch {
            return false;
          }
          reply =
            command.action === 'move'
              ? fr ? "C'est fait." : 'Done.'
              : command.target === 'mini'
                ? command.action === 'hide' ? (fr ? 'Mini fenêtre masquée.' : 'Mini window hidden.') : fr ? 'La voici.' : 'Here it is.'
                : command.action === 'show' ? (fr ? 'Me voici.' : 'Here I am.') : fr ? 'Je reste discret, mais je vous écoute.' : "I'll stay out of the way, still listening.";
          break;
        case 'dashboard': {
          await dashboardStore.load();
          if (command.action === 'hide') {
            dashboardStore.open(null);
            reply = fr ? 'Tableau de bord fermé.' : 'Dashboard closed.';
            break;
          }
          const d = findDashboard(command.name);
          if (!d) return false; // no such dashboard: the AI explains, or builds it
          dashboardStore.open(d.id);
          reply = fr ? `Voici « ${d.name} ».` : `Here is "${d.name}".`;
          break;
        }
        case 'open_app':
          // Approval mode: the AI shows the approval card as usual.
          if (!s.autonomous) return false;
          try {
            await invoke<string>('os_open_app', { name: command.name });
          } catch {
            return false; // unknown app: the AI may know better ("the browser"…)
          }
          reply = fr ? "C'est ouvert." : 'Done.';
          break;
      }
      recordLocalAnswer(command.kind);
      setMessages((prev) => [...prev, { id: uid(), role: 'user', content: text }]);
      addLocalReply(reply);
      if (source === 'voice' || s.speakReplies) await say(reply, `local-${uid()}`);
      return true;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [startTimer, addLocalReply, say, stopSpeaking, standBy],
  );
}
