import { useState } from 'react';
import { embed, hasEnoughSpeech, recordSample, useVoices, voiceStore, type VoiceProfile } from '../../lib/voiceprint';
import { uiLocale, useT } from '../../i18n';

/**
 * Recording a voice for Iris to recognise (lib/voiceprint.ts): the user reads three sentences;
 * their voiceprints, averaged, make the voice's profile. Shared by the first-launch setup and
 * Settings (add a voice, record one again).
 */

const SAMPLE_MS = 5000;

export function VoiceEnroll({ replace, onDone, onCancel }: { replace?: VoiceProfile; onDone: (voice: VoiceProfile) => void; onCancel?: () => void }) {
  const all = useT();
  const t = all.voices;
  const [name, setName] = useState(replace?.name ?? t.defaultName);
  const [samples, setSamples] = useState<number[][]>([]);
  const [state, setState] = useState<'idle' | 'recording' | 'processing' | { error: string }>('idle');
  const [level, setLevel] = useState(0);
  const index = samples.length;
  const total = t.prompts.length;
  const done = index >= total;

  const record = async () => {
    setState('recording');
    try {
      const audio = await recordSample(SAMPLE_MS, setLevel);
      if (!hasEnoughSpeech(audio)) {
        setState({ error: t.tooQuiet });
        return;
      }
      setState('processing');
      const vector = await embed(audio);
      setSamples((s) => [...s, vector]);
      setState('idle');
    } catch (error) {
      setState({ error: t.failed(error instanceof Error ? error.message : String(error)) });
    }
  };

  const save = () => {
    if (replace) {
      voiceStore.replace(replace.id, samples);
      onDone({ ...replace });
    } else {
      onDone(voiceStore.add(name, samples));
    }
  };

  return (
    <div className="voice-enroll">
      {!replace && (
        <label className="set-field">
          <span className="set-label">{t.nameLabel}</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
        </label>
      )}
      <p className="set-hint">{t.recordIntro}</p>
      <ol className="voice-steps" aria-hidden>
        {t.prompts.map((_, i) => (
          <li key={i} className={i < index ? 'is-done' : i === index ? 'is-current' : ''} />
        ))}
      </ol>
      {!done ? (
        <>
          <p className="set-label">{t.sentence(index + 1, total)}</p>
          <blockquote className="voice-prompt">{t.prompts[index]}</blockquote>
          <div className="voice-record">
            <button type="button" className="set-btn" onClick={() => void record()} disabled={state === 'recording' || state === 'processing'}>
              {state === 'recording' ? t.recording : state === 'processing' ? t.processing : t.record}
            </button>
            <span className="voice-level" aria-hidden>
              <i style={{ transform: `scaleX(${state === 'recording' ? Math.max(0.03, level) : 0})` }} />
            </span>
          </div>
        </>
      ) : (
        <div className="voice-record">
          <button type="button" className="set-btn" onClick={save}>
            {t.save}
          </button>
          <button type="button" className="set-link set-link--quiet" onClick={() => setSamples([])}>
            {t.again}
          </button>
        </div>
      )}
      {typeof state === 'object' && <span className="set-warn">{state.error}</span>}
      {onCancel && (
        <button type="button" className="set-link set-link--quiet" onClick={onCancel}>
          ← {all.common.cancel}
        </button>
      )}
    </div>
  );
}

/** Settings: the recognised voices, and whether Iris also listens to everyone else. */
export function VoicesManager({ voiceLock, onVoiceLock }: { voiceLock: boolean; onVoiceLock: (lock: boolean) => void }) {
  const all = useT();
  const t = all.voices;
  const voices = useVoices();
  const [editing, setEditing] = useState<VoiceProfile | 'new' | null>(null);

  if (editing) {
    return (
      <VoiceEnroll
        replace={editing === 'new' ? undefined : editing}
        onDone={() => {
          if (editing === 'new' && voices.length === 0) onVoiceLock(true);
          setEditing(null);
        }}
        onCancel={() => setEditing(null)}
      />
    );
  }

  return (
    <>
      <p className="set-hint">{t.intro}</p>
      {voices.length === 0 ? (
        <p className="set-hint">{t.none}</p>
      ) : (
        <ul className="set-memory">
          {voices.map((v) => (
            <li key={v.id}>
              <input
                className="voice-name"
                defaultValue={v.name}
                aria-label={t.nameLabel}
                onBlur={(e) => e.target.value.trim() && e.target.value !== v.name && voiceStore.rename(v.id, e.target.value)}
              />
              <span className="set-hint">{t.recordedOn(new Date(v.createdAt).toLocaleDateString(uiLocale()))}</span>
              <button type="button" className="set-link" onClick={() => setEditing(v)}>
                {t.rerecord}
              </button>
              <button type="button" className="set-link" onClick={() => voiceStore.remove(v.id)}>
                {t.remove}
              </button>
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="set-btn set-btn--ghost set-btn--sm voice-add" onClick={() => setEditing('new')}>
        + {t.add}
      </button>
      <label className="set-toggle">
        <input type="checkbox" checked={!voiceLock || voices.length === 0} disabled={voices.length === 0} onChange={(e) => onVoiceLock(!e.target.checked)} />
        <span>
          {t.listenOthers}
          <small className="set-hint">{t.listenOthersHint}</small>
        </span>
      </label>
    </>
  );
}
