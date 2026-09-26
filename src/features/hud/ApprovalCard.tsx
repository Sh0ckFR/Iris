import { motion } from 'framer-motion';
import type { ActionRequest } from '../assistant/osTools';
import { useT } from '../../i18n';

interface Props {
  request: ActionRequest;
  /** Other actions waiting behind this one (several tasks can ask at once). */
  queued?: number;
  /** `always`: also trust this action from now on (offered when the request allows it). */
  onRespond: (allowed: boolean, always?: boolean) => void;
}

/** Human-in-the-loop gate: nothing runs on the computer until the user clicks Allow. */
export function ApprovalCard({ request, queued = 0, onRespond }: Props) {
  const t = useT().approval;
  return (
    <motion.div
      className={`hud-approval hud-approval--${request.risk}`}
      role="alertdialog"
      aria-label={request.title}
      initial={{ opacity: 0, y: 16, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 10, scale: 0.98 }}
      transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
    >
      <div className="hud-approval-head">
        <span className="hud-approval-risk">
          {t.risk[request.risk]}
          {queued > 0 && t.moreWaiting(queued)}
        </span>
        <h3>{request.title}</h3>
      </div>
      <dl className="hud-approval-details">
        {request.details.map((d) => (
          <div key={d.label}>
            <dt>{d.label}</dt>
            <dd className={d.mono ? 'mono' : undefined}>{d.value}</dd>
          </div>
        ))}
      </dl>
      <div className="hud-approval-actions">
        <button type="button" className="set-btn set-btn--ghost" onClick={() => onRespond(false)}>
          {t.decline} <kbd>Esc</kbd>
        </button>
        {request.onAlways && (
          <button type="button" className="set-btn set-btn--ghost" onClick={() => onRespond(true, true)}>
            {t.alwaysAllow}
          </button>
        )}
        <button type="button" className="set-btn" onClick={() => onRespond(true)} autoFocus>
          {t.allow} <kbd>{t.enterKey}</kbd>
        </button>
      </div>
      <p className="hud-approval-voice">{t.voiceHint}</p>
    </motion.div>
  );
}
