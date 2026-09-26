import { useEffect, useRef } from 'react';
import type { ChatMessage, Phase } from '../assistant/useAssistant';
import { BRIEFING_ICON, type Briefing } from '../assistant/tools';
import { useT } from '../../i18n';

interface Props {
  messages: ChatMessage[];
  phase: Phase;
  activeBriefingId: string | null;
  onShowBriefing: (briefing: Briefing) => void;
}

export function ConversationLog({ messages, phase, activeBriefingId, onShowBriefing }: Props) {
  const log = useRef<HTMLDivElement>(null);
  /** Following the conversation; off while the user reads further up. */
  const pinned = useRef(true);
  const t = useT();
  const last = messages[messages.length - 1];

  // Only the log scrolls: scrollIntoView() also scrolled the panel itself (overflow: hidden is
  // still scrollable by script), which shifted its resize edges away from its visible border.
  useEffect(() => {
    const el = log.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, last?.content, last?.briefings?.length]);

  const onScroll = () => {
    const el = log.current;
    if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  if (messages.length === 0) {
    return (
      <div className="hud-log-empty">
        <p>{t.log.empty}</p>
        <p>{t.log.howTo}</p>
        <p className="hud-log-hint">{t.log.tryThis}</p>
      </div>
    );
  }

  return (
    <div ref={log} className="hud-log" onScroll={onScroll}>
      {messages.map((m) => {
        const streaming = m === last && m.role === 'assistant' && (phase === 'thinking' || phase === 'speaking');
        return (
          <div key={m.id} className={`hud-msg hud-msg--${m.role}${m.error ? ' hud-msg--error' : ''}`}>
            <span className="hud-msg-who">{m.role === 'user' ? t.common.you : 'Iris'}</span>
            {m.attachments?.map((a) => (
              <span key={a.name} className="hud-chip hud-chip--file" title={a.name}>
                <span aria-hidden>{a.kind === 'pdf' ? '📕' : a.kind === 'image' ? '🖼️' : '📄'}</span> {a.name}
              </span>
            ))}
            {m.briefings?.map((b) => (
              <button
                key={b.id}
                type="button"
                className={`hud-chip${b.id === activeBriefingId ? ' hud-chip--active' : ''}`}
                onClick={() => onShowBriefing(b)}
              >
                <span aria-hidden>{BRIEFING_ICON[b.kind]}</span> {b.heading}
              </button>
            ))}
            {(m.content || streaming || !m.briefings?.length) && (
              <p>
                {m.content || (streaming ? '' : '…')}
                {streaming && <span className="hud-caret" />}
              </p>
            )}
            {m.role === 'assistant' && m.brain && <span className="hud-msg-brain">{m.brain}</span>}
          </div>
        );
      })}
    </div>
  );
}
