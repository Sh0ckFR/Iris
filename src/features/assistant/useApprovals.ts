import { useCallback, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { ActionRequest } from './osTools';
import { playSfx } from './sfx';
import { voiceAnswer } from './untrusted';

/**
 * Approval cards, queued (several tasks can ask at once). An approval asked during a spoken
 * exchange is also asked aloud, and the user can answer by voice ("oui, vas-y" / "non").
 */

export interface PendingApproval {
  taskId: string;
  request: ActionRequest;
  resolve: (allowed: boolean) => void;
}

interface Options {
  /** Says a line on its own speech channel. */
  say: (text: string, channel: string) => Promise<void>;
  /** Stops a speech channel (the question, once answered). */
  silence: (channel: string) => void;
  /** "Monsieur" / "sir" (Settings) in the reply language. */
  honorific: (lang: 'fr' | 'en') => string;
  replyLang: () => 'fr' | 'en';
}

export function useApprovals({ say, silence, honorific, replyLang }: Options) {
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const approvalsRef = useRef<PendingApproval[]>([]);
  const sync = () => setApprovals([...approvalsRef.current]);

  /** Answers the approval card on top of the queue ("always" = also trust it from now on). */
  const respondToAction = useCallback((allowed: boolean, always = false) => {
    const [first, ...rest] = approvalsRef.current;
    if (!first) return;
    approvalsRef.current = rest;
    sync();
    silence('approval');
    if (allowed && always) first.request.onAlways?.();
    playSfx(allowed ? 'approve' : 'decline');
    first.resolve(allowed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Declines the pending approvals of one task (or all). */
  const declineApprovals = useCallback((taskId?: string) => {
    const [dropped, kept] = approvalsRef.current.reduce<[PendingApproval[], PendingApproval[]]>(
      ([d, k], a) => (taskId === undefined || a.taskId === taskId ? [[...d, a], k] : [d, [...k, a]]),
      [[], []],
    );
    if (dropped.length === 0) return;
    approvalsRef.current = kept;
    sync();
    dropped.forEach((a) => a.resolve(false));
  }, []);

  /**
   * Shows an approval card (and, for a spoken exchange, asks aloud — `question` replaces the
   * usual line); resolves with the answer.
   */
  const requestApproval = useCallback(
    (taskId: string, request: ActionRequest, spoken: boolean, question?: string) =>
      new Promise<boolean>((resolve) => {
        approvalsRef.current = [...approvalsRef.current, { taskId, request, resolve }];
        sync();
        playSfx('alert');
        // The card must be seen: bring the interface back if Iris is in the background.
        void invoke('window_control', { target: 'main', action: 'show', position: null }).catch(() => {});
        if (!spoken) return;
        const lang = replyLang();
        const hon = honorific(lang);
        const line =
          question ??
          (lang === 'fr'
            ? `${hon ? `${hon}, j'ai` : "J'ai"} besoin de votre accord : ${request.title}. Je continue ?`
            : `${hon ? `${hon}, I` : 'I'} need your approval: ${request.title}. Shall I go ahead?`);
        void say(line, 'approval');
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [say],
  );

  /** A spoken "oui" / "non" while an approval waits: answers it. Returns whether it did. */
  const answerByVoice = useCallback(
    (text: string): boolean => {
      if (approvalsRef.current.length === 0) return false;
      const answer = voiceAnswer(text);
      if (!answer) return false;
      console.warn(`[iris:voice] approval answered by voice: ${answer} ("${text}")`);
      respondToAction(answer === 'yes');
      return true;
    },
    [respondToAction],
  );

  return {
    approvals,
    pendingAction: approvals[0]?.request ?? null,
    pendingCount: approvals.length,
    respondToAction,
    declineApprovals,
    requestApproval,
    answerByVoice,
  };
}
