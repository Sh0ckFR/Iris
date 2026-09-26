import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { IrisLogo } from './IrisLogo';
import { useT } from '../../i18n';

/**
 * Short cinematic boot overlay shown when the HUD comes online: the eye opens, then the systems
 * report in.
 * Click anywhere to skip. Calls `onDone` when finished.
 */
export function BootSequence({ onDone, brain, voice }: { onDone: () => void; brain: string | null; voice: string }) {
  const t = useT().boot;
  const core = brain ? `[${brain.toUpperCase()}]` : t.noKey;
  const lines = [t.initializing, t.neuralCore(core), t.voiceLink(voice.toUpperCase()), t.sensors, t.security, t.ready];
  const [shown, setShown] = useState(0);

  useEffect(() => {
    if (shown < lines.length) {
      const id = window.setTimeout(() => setShown((n) => n + 1), shown === 0 ? 250 : 280);
      return () => window.clearTimeout(id);
    }
    const id = window.setTimeout(onDone, 650);
    return () => window.clearTimeout(id);
  }, [shown, lines.length, onDone]);

  return (
    <motion.div
      className="boot"
      onClick={onDone}
      initial={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.6 } }}
      role="status"
      aria-live="polite"
    >
      <motion.div
        className="boot-logo"
        initial={{ opacity: 0, scale: 0.6, rotate: -90 }}
        animate={{ opacity: 1, scale: 1, rotate: 0 }}
        transition={{ duration: 0.9, ease: [0.16, 1, 0.3, 1] }}
      >
        <IrisLogo size={168} phase={shown < lines.length ? 'thinking' : 'listening'} />
      </motion.div>
      <div className="boot-lines">
        {lines.slice(0, shown).map((line, i) => (
          <motion.p
            key={line}
            className={i === lines.length - 1 ? 'boot-final' : undefined}
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.2 }}
          >
            {line}
          </motion.p>
        ))}
        <span className="boot-cursor" />
      </div>
    </motion.div>
  );
}
