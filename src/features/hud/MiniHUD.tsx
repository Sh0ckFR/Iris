import { useEffect, useRef, useState, type FormEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { emitTo, listen } from '@tauri-apps/api/event';
import { MINI_HELLO_EVENT, MINI_LEVEL_EVENT, MINI_SEND_EVENT, MINI_STATUS_EVENT, type MiniStatus } from '../../lib/miniWindow';
import { IrisLogo } from './IrisLogo';
import { useT } from '../../i18n';
import './MiniHUD.css';

/**
 * The small always-on-top window shown above the tray icon while the interface is closed:
 * Iris's state, her last words, a field to write to her (when speaking isn't possible), and
 * buttons to open the interface or hide this window. Everything it shows comes from the main
 * window (events), where Iris actually runs; what is typed here is sent there.
 */

export function MiniHUD() {
  const t = useT().mini;
  const [state, setState] = useState<MiniStatus | null>(null);
  const [level, setLevel] = useState(0);
  const [draft, setDraft] = useState('');
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    document.documentElement.classList.add('mini-window');
    const offs = [
      listen<MiniStatus>(MINI_STATUS_EVENT, (e) => setState(e.payload)),
      listen<number>(MINI_LEVEL_EVENT, (e) => setLevel(e.payload)),
    ];
    // Ask the main window for the current state (it may have started first).
    void emitTo('main', MINI_HELLO_EVENT);
    return () => offs.forEach((p) => void p.then((off) => off()));
  }, []);

  const control = (target: 'main' | 'mini', action: 'show' | 'hide') => () =>
    void invoke('window_control', { target, action, position: null });

  const send = (e: FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    void emitTo('main', MINI_SEND_EVENT, text);
    setDraft('');
    input.current?.focus(); // ready for a follow-up
  };

  return (
    <div className={`mini mini--${state?.phase ?? 'idle'}`} data-tauri-drag-region onDoubleClick={control('main', 'show')}>
      <div className="mini-top" data-tauri-drag-region>
        <button
          type="button"
          className="mini-orb"
          style={{ ['--level' as string]: String(Math.min(1, level)) }}
          onClick={control('main', 'show')}
          title={t.open}
          aria-label={t.open}
        >
          <IrisLogo size={38} phase={state?.phase ?? 'idle'} level={level} ring={false} className="mini-orb-eye" />
        </button>
        <div className="mini-text" data-tauri-drag-region>
          <div className="mini-brand" data-tauri-drag-region>
            I.R.I.S
          </div>
          <div className="mini-status" data-tauri-drag-region>
            {state?.status ?? t.connecting}
          </div>
          {state?.reply && (
            <p className="mini-reply" data-tauri-drag-region>
              {state.reply}
            </p>
          )}
        </div>
        <div className="mini-actions">
          <button type="button" onClick={control('main', 'show')} title={t.openInterface}>
            ⤢
          </button>
          <button type="button" onClick={control('mini', 'hide')} title={t.hide}>
            ×
          </button>
        </div>
      </div>
      {/* Double-clicking in the field selects a word: it must not open the interface. */}
      <form className="mini-input" onSubmit={send} onDoubleClick={(e) => e.stopPropagation()}>
        <input
          ref={input}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setDraft('');
          }}
          placeholder={t.placeholder}
          aria-label={t.placeholder}
          maxLength={4000}
          spellCheck
          autoComplete="off"
        />
        <button type="submit" disabled={!draft.trim()} title={t.send} aria-label={t.send}>
          ➤
        </button>
      </form>
    </div>
  );
}
