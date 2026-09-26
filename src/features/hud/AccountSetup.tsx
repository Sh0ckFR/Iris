import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { CloudProvider, Settings } from '../../lib/settings';
import type { SecretKey, Secrets } from '../../lib/secrets';
import { connectedProvider, mediaProvider, PROVIDER_INFO, PROVIDERS, type MediaProvider } from '../../lib/providers';
import { useT } from '../../i18n';

/**
 * Connecting Iris to an AI provider, shared by the first-launch setup and Settings: pick a
 * provider, open its key page, paste the key; Iris checks it before saving it.
 */

export interface AccountActions {
  /**
   * Checks a key with its provider and saves it at once. `main`: Iris is now connected to this
   * provider; otherwise the key only brings the natural voice and images. Rejects when the key
   * doesn't work.
   */
  onConnect: (provider: CloudProvider, key: string, main: boolean) => Promise<void>;
  /** Erases these keys from the vault at once. */
  onForget: (keys: SecretKey[]) => void;
}

const openUrl = (url: string) => void invoke('os_open_url', { url }).catch(() => window.open(url, '_blank'));

export function ConnectForm({ provider, main, onConnect, onBack }: { provider: CloudProvider; main: boolean; onConnect: AccountActions['onConnect']; onBack?: () => void }) {
  const t = useT().account;
  const [key, setKey] = useState('');
  const [state, setState] = useState<'idle' | 'checking' | { error: string }>('idle');
  const info = PROVIDER_INFO[provider];
  const connect = async () => {
    const clean = key.trim();
    if (!clean || state === 'checking') return;
    setState('checking');
    try {
      await onConnect(provider, clean, main);
    } catch (error) {
      setState({ error: error instanceof Error ? error.message : String(error) });
    }
  };
  return (
    <div className="set-connect">
      <p className="set-label">{t.providers[provider].name}</p>
      <p className="set-connect-step">
        <b>1</b> {t.step1}
        <button type="button" className="set-btn set-btn--ghost set-btn--sm" onClick={() => openUrl(info.keyPage)}>
          {t.openPage} ↗
        </button>
      </p>
      <p className="set-connect-step">
        <b>2</b> {t.step2}
      </p>
      <div className="set-key">
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={key}
          placeholder={t.keyPlaceholder(info.name)}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void connect()}
          aria-label={t.keyPlaceholder(info.name)}
          autoFocus
        />
        <button type="button" className="set-btn" onClick={() => void connect()} disabled={!key.trim() || state === 'checking'}>
          {state === 'checking' ? t.checking : t.connect}
        </button>
      </div>
      {typeof state === 'object' && <span className="set-warn">{t.invalid(state.error)}</span>}
      <span className="set-hint">{t.billing}</span>
      {onBack && (
        <button type="button" className="set-link set-link--quiet" onClick={onBack}>
          ← {t.back}
        </button>
      )}
    </div>
  );
}

/** The three providers, as big buttons. */
export function ProviderChoice({ onChoose, only }: { onChoose: (p: CloudProvider) => void; only?: CloudProvider[] }) {
  const t = useT().account;
  return (
    <div className={`set-providers${only ? ' set-providers--small' : ''}`}>
      {(only ?? PROVIDERS).map((p) => (
        <button key={p} type="button" className={`set-provider set-provider--${p}`} onClick={() => onChoose(p)}>
          <b>{only ? t.media.add(t.providers[p].name) : t.providers[p].name}</b>
          {!only && <span>{t.providers[p].hint}</span>}
        </button>
      ))}
    </div>
  );
}

/** Connected to …, with its model and a way to disconnect (the keys are erased to start over). */
export function ConnectedCard({ settings, secrets, onForget }: { settings: Settings; secrets: Secrets; onForget: AccountActions['onForget'] }) {
  const all = useT();
  const t = all.account;
  const main = connectedProvider(settings, secrets);
  const [confirm, setConfirm] = useState(false);
  if (!main) return null;
  const model = settings.cloudModels[main];
  return (
    <div className="set-account">
      <span className="set-account-dot" aria-hidden />
      <div className="set-account-text">
        <b>{t.connected(t.providers[main].name)}</b>
        {model && <span className="set-hint">{t.model(model)}</span>}
      </div>
      {confirm ? (
        <span className="set-account-confirm">
          {t.disconnectConfirm}{' '}
          <button
            type="button"
            className="set-link"
            onClick={() => {
              setConfirm(false);
              onForget(['openai', 'anthropic', 'google']);
            }}
          >
            {t.disconnectYes}
          </button>{' '}
          <button type="button" className="set-link set-link--quiet" onClick={() => setConfirm(false)}>
            {all.common.cancel}
          </button>
        </span>
      ) : (
        <button type="button" className="set-btn set-btn--ghost set-btn--sm" onClick={() => setConfirm(true)}>
          {t.disconnect}
        </button>
      )}
    </div>
  );
}

/**
 * Connected to Anthropic: an optional OpenAI or Gemini key for the natural voice and images.
 * `onSkip` (first-launch setup) offers to go on with the free local voice.
 */
export function MediaKey({ settings, secrets, onConnect, onForget, onSkip }: { settings: Settings; secrets: Secrets; onSkip?: () => void } & AccountActions) {
  const t = useT().account;
  const [choice, setChoice] = useState<MediaProvider | null>(null);
  const media = mediaProvider(settings, secrets);
  if (media) {
    return (
      <p className="set-hint set-media-ok">
        ✓ {t.media.via(t.providers[media].name)}{' '}
        <button type="button" className="set-link" onClick={() => onForget([media])}>
          {t.media.remove}
        </button>
      </p>
    );
  }
  if (choice) return <ConnectForm provider={choice} main={false} onConnect={onConnect} onBack={() => setChoice(null)} />;
  return (
    <>
      <p className="set-hint">{t.media.intro}</p>
      <ProviderChoice only={['openai', 'google']} onChoose={(p) => setChoice(p as MediaProvider)} />
      {onSkip && (
        <button type="button" className="set-link set-link--quiet" onClick={onSkip}>
          {t.media.skip}
        </button>
      )}
    </>
  );
}

/** Settings → AI account. */
export function AccountSection({ settings, secrets, onConnect, onForget }: { settings: Settings; secrets: Secrets } & AccountActions) {
  const t = useT().account;
  const [choice, setChoice] = useState<CloudProvider | null>(null);
  const main = connectedProvider(settings, secrets);
  return (
    <section>
      <h3>{t.title}</h3>
      {main ? (
        <>
          <ConnectedCard settings={settings} secrets={secrets} onForget={onForget} />
          {main === 'anthropic' && (
            <div className="set-subsection">
              <p className="set-label">{t.media.title}</p>
              <MediaKey settings={settings} secrets={secrets} onConnect={onConnect} onForget={onForget} />
            </div>
          )}
        </>
      ) : (
        <>
          <p className="set-note">{t.intro}</p>
          {choice ? (
            <ConnectForm provider={choice} main onConnect={onConnect} onBack={() => setChoice(null)} />
          ) : (
            <ProviderChoice onChoose={setChoice} />
          )}
        </>
      )}
    </section>
  );
}
