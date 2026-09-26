import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import type { CloudProvider, Settings } from '../../lib/settings';
import type { Secrets } from '../../lib/secrets';
import { connectedProvider, mediaProvider } from '../../lib/providers';
import { LANGUAGES, isUiLanguage, useT } from '../../i18n';
import { ConnectForm, ConnectedCard, MediaKey, ProviderChoice, type AccountActions } from './AccountSetup';
import { IrisLogo } from './IrisLogo';
import { VoiceEnroll } from './VoiceSetup';
import { useVoices } from '../../lib/voiceprint';
import { IS_DESKTOP, OS_NAME, PLATFORM } from '../../lib/platform';

/**
 * First launch, step by step: the interface language, the AI account (one provider sets
 * everything up), for Anthropic an optional key for the voice and images, the user's voice (so
 * that Iris answers only them, unless she may listen to everyone), then a few options.
 * Every choice applies at once; all of it can be changed later in Settings.
 */

type Step = 'language' | 'account' | 'media' | 'voice' | 'options' | 'done';

interface Props extends AccountActions {
  settings: Settings;
  secrets: Secrets;
  /** Applies a change at once. */
  onChange: (patch: Partial<Settings>) => void;
  onFinish: () => void;
}

export function SetupWizard({ settings, secrets, onChange, onFinish, onConnect, onForget }: Props) {
  const all = useT();
  const t = all.setup;
  const [step, setStep] = useState<Step>('language');
  const [choice, setChoice] = useState<CloudProvider | null>(null);
  const main = connectedProvider(settings, secrets);
  const media = mediaProvider(settings, secrets);
  const voices = useVoices();
  const steps: Step[] = ['language', 'account', ...(main === 'anthropic' ? (['media'] as Step[]) : []), 'voice', 'options', 'done'];
  const index = steps.indexOf(step);
  const go = (delta: number) => setStep(steps[Math.max(0, Math.min(steps.length - 1, index + delta))]);
  const honorificPreset = ['', 'Monsieur', 'Madame'].includes(settings.honorific);

  const connect: AccountActions['onConnect'] = async (provider, key, isMain) => {
    await onConnect(provider, key, isMain);
    setChoice(null);
    // Connected: straight on (Anthropic first offers a voice and images).
    if (isMain) setStep(provider === 'anthropic' ? 'media' : 'voice');
    else setStep('voice');
  };

  return (
    <motion.div className="setup" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.4 } }}>
      <motion.div
        className="setup-card"
        role="dialog"
        aria-label={t.welcome}
        initial={{ opacity: 0, y: 24, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
      >
        <header className="setup-head">
          <IrisLogo size={72} phase={step === 'done' ? 'listening' : 'idle'} />
          <div>
            <h2>{t.welcome}</h2>
            <p className="set-hint">{t.welcomeText}</p>
          </div>
        </header>

        <ol className="setup-steps" aria-label={t.progress}>
          {steps.map((s, i) => (
            <li key={s} className={i < index ? 'is-done' : i === index ? 'is-current' : ''}>
              <span>{i < index ? '✓' : i + 1}</span>
              {t.steps[s]}
            </li>
          ))}
        </ol>

        <AnimatePresence mode="wait">
          <motion.div
            key={step}
            className="setup-body"
            initial={{ opacity: 0, x: 16 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -16 }}
            transition={{ duration: 0.22 }}
          >
            {step === 'language' && (
              <>
                <h3>{t.languageTitle}</h3>
                <p className="set-hint">{t.languageHint}</p>
                <div className="setup-languages">
                  {Object.entries(LANGUAGES).map(([code, lang]) => (
                    <button
                      key={code}
                      type="button"
                      lang={code}
                      className={settings.uiLanguage === code ? 'is-on' : ''}
                      onClick={() => isUiLanguage(code) && onChange({ uiLanguage: code })}
                    >
                      {lang.name}
                    </button>
                  ))}
                </div>
              </>
            )}

            {step === 'account' && (
              <>
                <h3>{t.accountTitle}</h3>
                {main ? (
                  <ConnectedCard settings={settings} secrets={secrets} onForget={onForget} />
                ) : choice ? (
                  <ConnectForm provider={choice} main onConnect={connect} onBack={() => setChoice(null)} />
                ) : (
                  <>
                    <p className="set-hint">{all.account.intro}</p>
                    <ProviderChoice onChoose={setChoice} />
                  </>
                )}
              </>
            )}

            {step === 'media' && (
              <>
                <h3>{t.mediaTitle}</h3>
                <MediaKey settings={settings} secrets={secrets} onConnect={connect} onForget={onForget} onSkip={() => setStep('voice')} />
              </>
            )}

            {step === 'voice' && (
              <>
                <h3>{t.voiceTitle}</h3>
                <p className="set-hint">{all.voices.intro}</p>
                {voices.length === 0 ? (
                  <>
                    <VoiceEnroll onDone={() => onChange({ voiceLock: true })} />
                    <button type="button" className="set-link set-link--quiet" onClick={() => go(1)}>
                      {t.voiceSkip}
                    </button>
                  </>
                ) : (
                  <>
                    <p className="set-hint set-media-ok">✓ {voices.map((v) => v.name).join(', ')}</p>
                    <label className="set-toggle">
                      <input type="checkbox" checked={!settings.voiceLock} onChange={(e) => onChange({ voiceLock: !e.target.checked })} />
                      <span>
                        {all.voices.listenOthers}
                        <small className="set-hint">{all.voices.listenOthersHint}</small>
                      </span>
                    </label>
                  </>
                )}
              </>
            )}

            {step === 'options' && (
              <>
                <h3>{t.optionsTitle}</h3>
                <label className="set-field">
                  <span className="set-label">{all.settings.voice.irisVoice}</span>
                  <select value={media ? settings.ttsEngine : 'local'} onChange={(e) => onChange({ ttsEngine: e.target.value === 'local' ? 'local' : 'natural' })} disabled={!media}>
                    {media && <option value="natural">{all.settings.voice.natural(all.account.providers[media].name)}</option>}
                    <option value="local">{all.settings.voice.local}</option>
                  </select>
                  <span className="set-hint">{media ? all.settings.voice.naturalHint(all.account.providers[media].name) : all.settings.voice.localHint}</span>
                </label>
                <label className="set-field">
                  <span className="set-label">{all.settings.personality.address}</span>
                  <select
                    value={honorificPreset ? settings.honorific : '__name'}
                    onChange={(e) => onChange({ honorific: e.target.value === '__name' ? settings.honorific || ' ' : e.target.value })}
                  >
                    <option value="">{all.settings.personality.none}</option>
                    <option value="Monsieur">{all.settings.personality.monsieur}</option>
                    <option value="Madame">{all.settings.personality.madame}</option>
                    <option value="__name">{all.settings.personality.byName}</option>
                  </select>
                </label>
                {!honorificPreset && (
                  <label className="set-field">
                    <span className="set-label">{all.settings.personality.firstName}</span>
                    <input value={settings.honorific.trim()} onChange={(e) => onChange({ honorific: e.target.value || ' ' })} autoFocus />
                  </label>
                )}
                <label className="set-toggle">
                  <input type="checkbox" checked={settings.autonomous} onChange={(e) => onChange({ autonomous: e.target.checked })} />
                  <span>
                    {all.settings.voice.autonomous}
                    <small className="set-hint">{t.autonomousHint}</small>
                  </span>
                </label>
                {IS_DESKTOP && (
                  <label className="set-toggle">
                    <input type="checkbox" checked={settings.launchAtStartup} onChange={(e) => onChange({ launchAtStartup: e.target.checked })} />
                    {all.settings.personality.launchAtStartup(OS_NAME[PLATFORM])}
                  </label>
                )}
                <label className="set-toggle">
                  <input type="checkbox" checked={settings.speakReplies} onChange={(e) => onChange({ speakReplies: e.target.checked })} />
                  {all.settings.voice.speakReplies}
                </label>
              </>
            )}

            {step === 'done' && (
              <>
                <h3>{t.doneTitle}</h3>
                <p className="setup-done">{t.doneText}</p>
              </>
            )}
          </motion.div>
        </AnimatePresence>

        <footer className="setup-foot">
          {index > 0 && step !== 'done' ? (
            <button type="button" className="set-btn set-btn--ghost" onClick={() => go(-1)}>
              {t.back}
            </button>
          ) : (
            <span />
          )}
          {step === 'done' ? (
            <button type="button" className="set-btn" onClick={onFinish} autoFocus>
              {t.finish}
            </button>
          ) : (
            <button type="button" className="set-btn" onClick={() => go(1)} disabled={step === 'account' && !main}>
              {t.next}
            </button>
          )}
        </footer>
      </motion.div>
    </motion.div>
  );
}
