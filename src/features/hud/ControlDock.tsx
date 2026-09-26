import { useEffect, useRef, useState, type FormEvent } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import type { Phase, Task } from '../assistant/useAssistant';
import type { LocalWakeStatus } from '../assistant/localWake';
import { ACCEPTED_FILES, formatSize, type Attachment } from '../assistant/documents';
import { CloseIcon, PaperclipIcon, SendIcon, SpeakerOffIcon } from './icons';
import { t as messages, useT } from '../../i18n';

interface Props {
  phase: Phase;
  /** A live OpenAI Realtime voice session is open. */
  voiceActive: boolean;
  /** Iris is talking right now. */
  speaking: boolean;
  /** What a task is doing right now, e.g. "Checking the news…". */
  activity: string | null;
  voiceReady: boolean;
  /** Always-on listening (local "Iris" detection). */
  wake: { status: LocalWakeStatus; detail?: string };
  tasks: Task[];
  onCancelTask: (id: string) => void;
  onCancelAll: () => void;
  /** Files waiting to be sent with the next message. */
  attachments: Attachment[];
  onAttach: (files: File[]) => void;
  onRemoveAttachment: (id: string) => void;
  /** Cut Iris off (voice only). */
  onStopSpeaking: () => void;
  onSend: (text: string) => void;
}

const KIND_ICON: Record<Attachment['kind'], string> = { pdf: '📕', image: '🖼️', text: '📄' };

/** Why Iris can't listen yet (shown instead of the idle status). */
function listeningProblem(wake: Props['wake'], voiceReady: boolean): string | null {
  const t = messages().dock;
  if (!voiceReady) return t.needKey;
  if (wake.status === 'loading') return t.loadingSpeech(wake.detail ? ` ${wake.detail}` : '');
  if (wake.status === 'error') return t.micUnavailable(wake.detail ?? '');
  return null;
}

/** The one-line status under the input (also shown in the mini window). */
export function statusLine({
  phase,
  activity,
  running,
  voiceActive,
  wake,
  voiceReady,
}: {
  phase: Phase;
  activity: string | null;
  /** Number of running tasks. */
  running: number;
  voiceActive: boolean;
  wake: Props['wake'];
  voiceReady: boolean;
}): string {
  const t = messages().dock;
  if (activity) return activity;
  if (running > 1 && !voiceActive) return t.tasksRunning(running);
  if (phase === 'idle') return listeningProblem(wake, voiceReady) ?? t.status.idle;
  return t.status[phase];
}

/** Live elapsed time of a task (frozen once it ends). */
function Elapsed({ since, until }: { since: number; until?: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (until) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [until]);
  const s = Math.max(0, Math.round(((until ?? now) - since) / 1000));
  return <span className="hud-task-time">{s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`}</span>;
}

const TASK_ICON: Record<Task['status'], string> = { running: '', done: '✓', error: '!', cancelled: '–' };

/** Tray of the requests Iris is working on (several can run at once). */
function TaskTray({ tasks, onCancel, onCancelAll }: { tasks: Task[]; onCancel: (id: string) => void; onCancelAll: () => void }) {
  const visible = tasks.slice(-5);
  const running = tasks.filter((t) => t.status === 'running').length;
  const m = useT().dock;
  return (
    <div className="hud-tasks-wrap">
      {running >= 2 && (
        <button type="button" className="hud-tasks-cancel-all" onClick={onCancelAll}>
          {m.cancelAll(running)}
        </button>
      )}
      <ul className="hud-tasks" aria-label={m.tasks}>
        <AnimatePresence initial={false}>
          {visible.map((t) => (
            <motion.li
              key={t.id}
              layout
              className={`hud-task hud-task--${t.status}`}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.2 } }}
            >
              <span className="hud-task-icon" aria-hidden>
                {t.status === 'running' ? <span className="hud-spinner" /> : TASK_ICON[t.status]}
              </span>
              <span className="hud-task-title" title={t.title}>
                {t.source === 'voice' && <span className="hud-task-src">🎙 </span>}
                {t.title}
              </span>
              {t.activity && <span className="hud-task-activity">{t.activity}</span>}
              <Elapsed since={t.startedAt} until={t.endedAt} />
              {t.status === 'running' && (
                <button type="button" className="hud-task-cancel" onClick={() => onCancel(t.id)} aria-label={m.cancelTask}>
                  <CloseIcon width={12} height={12} />
                </button>
              )}
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
    </div>
  );
}

export function ControlDock({
  phase,
  voiceActive,
  speaking,
  activity,
  voiceReady,
  wake,
  tasks,
  onCancelTask,
  onCancelAll,
  attachments,
  onAttach,
  onRemoveAttachment,
  onStopSpeaking,
  onSend,
}: Props) {
  const [draft, setDraft] = useState('');
  const picker = useRef<HTMLInputElement>(null);
  const running = tasks.filter((t) => t.status === 'running').length;
  const t = useT();
  const canSend = !!draft.trim() || attachments.length > 0;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!canSend) return;
    onSend(draft); // never blocks: each message becomes its own task
    setDraft('');
  };

  const status = statusLine({ phase, activity, running, voiceActive, wake, voiceReady });

  return (
    <motion.div
      className="hud-dock"
      initial={{ opacity: 0, y: 30 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.3, duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
    >
      {tasks.length > 0 && <TaskTray tasks={tasks} onCancel={onCancelTask} onCancelAll={onCancelAll} />}

      <div className={`hud-status hud-status--${phase}`}>
        <AnimatePresence mode="wait">
          <motion.span
            key={status}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.18 }}
          >
            {status}
          </motion.span>
        </AnimatePresence>
      </div>

      {attachments.length > 0 && (
        <ul className="hud-attachments">
          {attachments.map((a) => (
            <li key={a.id} className="hud-attachment" title={a.name}>
              <span aria-hidden>{KIND_ICON[a.kind]}</span>
              <span className="hud-attachment-name">{a.name}</span>
              <span className="hud-task-time">{formatSize(a.size)}</span>
              <button type="button" className="hud-task-cancel" onClick={() => onRemoveAttachment(a.id)} aria-label={t.common.remove}>
                <CloseIcon width={12} height={12} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="hud-dock-row">
        <form className="hud-input" onSubmit={submit}>
          <button
            type="button"
            className="hud-icon-btn"
            onClick={() => picker.current?.click()}
            aria-label={t.dock.attach}
            title={t.dock.attachTitle}
          >
            <PaperclipIcon />
          </button>
          <input
            ref={picker}
            type="file"
            multiple
            accept={ACCEPTED_FILES}
            hidden
            onChange={(e) => {
              onAttach(Array.from(e.target.files ?? []));
              e.target.value = '';
            }}
          />
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={t.dock.placeholder}
            aria-label={t.dock.messageLabel}
          />
          <button type="submit" className="hud-icon-btn" disabled={!canSend} aria-label={t.dock.send}>
            <SendIcon />
          </button>
        </form>

        {/* Cut Iris off: voice only — tasks and the microphone are untouched. */}
        <AnimatePresence>
          {speaking && (
            <motion.button
              type="button"
              className="hud-icon-btn hud-round-btn hud-stop-voice"
              onClick={onStopSpeaking}
              aria-label={t.dock.cutOff}
              title={t.dock.cutOff}
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.8 }}
            >
              <SpeakerOffIcon width={18} height={18} />
            </motion.button>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}
