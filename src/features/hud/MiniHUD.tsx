import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { emitTo, listen } from '@tauri-apps/api/event';
import { MINI_HELLO_EVENT, MINI_LEVEL_EVENT, MINI_STATUS_EVENT, type MiniStatus } from '../../lib/miniWindow';
import { IrisLogo } from './IrisLogo';
import { useT } from '../../i18n';
import './MiniHUD.css';

/**
 * The small always-on-top window shown above the tray icon while the interface is closed:
 * Iris's state, her last words, and buttons to open the interface or hide this window.
 * Everything it shows comes from the main window (events), where Iris actually runs.
 */

export function MiniHUD() {
  const t = useT().mini;
  const [state, setState] = useState<MiniStatus | null>(null);
  const [level, setLevel] = useState(0);

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

  return (
    <div className={`mini mini--${state?.phase ?? 'idle'}`} data-tauri-drag-region onDoubleClick={control('main', 'show')}>
      <button
        type="button"
        className="mini-orb"
        style={{ ['--level' as string]: String(Math.min(1, level)) }}
        onClick={control('main', 'show')}
        title={t.open}
        aria-label={t.open}
      >
        <IrisLogo size={38}phase={state?.phase ?? 'idle'} level={level} ring={false} className="mini-orb-eye" />
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
  );
}
