import { useState, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { Settings } from '../../lib/settings';
import type { SecretKey, Secrets } from '../../lib/secrets';
import { parseMailAccount } from '../../lib/mail';
import { parseSyncConfig, syncService, useSyncStatus, type SyncConfig } from '../../lib/sync';
import { useSemanticState } from '../../lib/semantic';
import { useT } from '../../i18n';

/**
 * Settings sections of Iris's links with the user's world: her initiative (calendar, inbox,
 * weather, quiet hours), the memory sync between devices, and the search by meaning. Secrets
 * (addresses, passwords, tokens) go to the vault with the other keys, on Save.
 */

type SetKey = (id: SecretKey, value: string | null | undefined) => void;

interface Props {
  draft: Settings;
  patch: (p: Partial<Settings>) => void;
  secrets: Secrets;
  keys: Partial<Record<SecretKey, string | null>>;
  setKey: SetKey;
}

function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="set-field">
      <span className="set-label">{label}</span>
      {children}
      {hint && <span className="set-hint">{hint}</span>}
    </label>
  );
}

/** The value being edited: typed in this panel, else the saved one. */
const current = (id: SecretKey, keys: Props['keys'], secrets: Secrets) => (keys[id] === undefined ? secrets[id] : (keys[id] ?? undefined));

// ---------------------------------------------------------------- initiative

export function ProactivitySection({ draft, patch, secrets, keys, setKey }: Props) {
  const all = useT();
  const t = all.settings.proactive;
  const hours = Array.from({ length: 24 }, (_, h) => h);

  const saved = parseMailAccount(secrets.mail);
  const [mail, setMail] = useState({ host: saved?.host ?? '', port: String(saved?.port ?? 993), user: saved?.user ?? '', password: '' });
  const [test, setTest] = useState<string | null>(null);
  const editMail = (change: Partial<typeof mail>) => {
    const next = { ...mail, ...change };
    setMail(next);
    setTest(null);
    if (!next.host.trim() && !next.user.trim()) return setKey('mail', saved ? null : undefined);
    const password = next.password || saved?.password || '';
    setKey('mail', JSON.stringify({ host: next.host.trim(), port: Number(next.port) || 993, user: next.user.trim(), password }));
  };
  const account = parseMailAccount(current('mail', keys, secrets));
  const runTest = () => {
    if (!account) return;
    setTest(t.testing);
    invoke<unknown[]>('mail_unread', { account })
      .then((list) => setTest(t.testOk(list.length)))
      .catch((error: unknown) => setTest(t.testFailed(String(error))));
  };

  return (
    <section>
      <h3>{t.title}</h3>
      <label className="set-toggle">
        <input type="checkbox" checked={draft.proactive} onChange={(e) => patch({ proactive: e.target.checked })} />
        {t.enabled}
      </label>
      <div className="set-row">
        <Field label={t.quietFrom}>
          <select value={draft.quietStart} onChange={(e) => patch({ quietStart: Number(e.target.value) })}>
            {hours.map((h) => (
              <option key={h} value={h}>
                {t.hour(h)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t.quietTo}>
          <select value={draft.quietEnd} onChange={(e) => patch({ quietEnd: Number(e.target.value) })}>
            {hours.map((h) => (
              <option key={h} value={h}>
                {t.hour(h)}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label={t.city} hint={t.cityHint}>
        <input value={draft.weatherCity} onChange={(e) => patch({ weatherCity: e.target.value })} />
      </Field>
      <Field label={t.calendar} hint={t.calendarHint}>
        <textarea
          className="set-code"
          rows={3}
          spellCheck={false}
          value={current('calendar', keys, secrets) ?? ''}
          placeholder="https://calendar.google.com/calendar/ical/…/basic.ics"
          onChange={(e) => setKey('calendar', e.target.value.trim() ? e.target.value : secrets.calendar ? null : undefined)}
        />
      </Field>
      <div className="set-group">
        <h4>{t.mail}</h4>
        <p className="set-hint">{t.mailHint}</p>
        <div className="set-row">
          <Field label={t.host}>
            <input value={mail.host} placeholder="imap.gmail.com" spellCheck={false} onChange={(e) => editMail({ host: e.target.value })} />
          </Field>
          <Field label={t.port}>
            <input value={mail.port} inputMode="numeric" onChange={(e) => editMail({ port: e.target.value.replace(/\D/g, '') })} />
          </Field>
        </div>
        <Field label={t.user}>
          <input value={mail.user} spellCheck={false} autoComplete="off" onChange={(e) => editMail({ user: e.target.value })} />
        </Field>
        <Field label={t.password}>
          <input
            type="password"
            autoComplete="off"
            value={mail.password}
            placeholder={saved?.password ? all.settings.keys.saved : ''}
            onChange={(e) => editMail({ password: e.target.value })}
          />
        </Field>
        <div className="set-row">
          <button type="button" className="set-btn set-btn--ghost" disabled={!account} onClick={runTest}>
            {t.test}
          </button>
          {saved && (
            <button
              type="button"
              className="set-link"
              onClick={() => {
                setMail({ host: '', port: '993', user: '', password: '' });
                setKey('mail', null);
              }}
            >
              {all.common.remove}
            </button>
          )}
        </div>
        {test && <p className="set-hint">{test}</p>}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- sync

type SyncForm = { kind: 'off' | SyncConfig['kind']; url: string; user: string; password: string; token: string; passphrase: string };

export function SyncSection({ secrets, keys, setKey }: Omit<Props, 'draft' | 'patch'>) {
  const all = useT();
  const t = all.settings.sync;
  const status = useSyncStatus();
  const saved = parseSyncConfig(secrets.sync);
  const [form, setForm] = useState<SyncForm>({
    kind: saved?.kind ?? 'off',
    url: saved?.kind === 'webdav' ? saved.url : '',
    user: saved?.kind === 'webdav' ? saved.user : '',
    password: '',
    token: '',
    passphrase: '',
  });
  const edit = (change: Partial<SyncForm>) => {
    const next = { ...form, ...change };
    setForm(next);
    if (next.kind === 'off') return setKey('sync', saved ? null : undefined);
    // Secrets left empty keep their saved value.
    const keep = <K extends 'password' | 'token' | 'passphrase'>(k: K) => next[k] || (saved && k in saved ? (saved as Record<string, string>)[k] : '');
    const config =
      next.kind === 'webdav'
        ? { kind: 'webdav', url: next.url.trim(), user: next.user.trim(), password: keep('password'), passphrase: keep('passphrase') }
        : { kind: 'gist', token: keep('token').trim(), passphrase: keep('passphrase') };
    setKey('sync', JSON.stringify(config));
  };
  const config = parseSyncConfig(current('sync', keys, secrets));
  const locale = navigator.language;
  const line =
    status.phase === 'syncing'
      ? t.status.syncing
      : status.phase === 'error'
        ? t.status.error(status.error ?? '')
        : status.phase === 'ok' && status.lastSyncAt
          ? t.status.ok(new Date(status.lastSyncAt).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }))
          : config
            ? t.status.idle
            : t.status.off;
  const secret = (k: 'password' | 'token' | 'passphrase') => (saved && k in saved && (saved as Record<string, string>)[k] ? all.settings.keys.saved : '');

  return (
    <section>
      <h3>{t.title}</h3>
      <p className="set-hint">{t.intro}</p>
      <Field label={t.storage}>
        <select value={form.kind} onChange={(e) => edit({ kind: e.target.value as SyncForm['kind'] })}>
          <option value="off">{t.off}</option>
          <option value="webdav">{t.webdav}</option>
          <option value="gist">{t.gist}</option>
        </select>
      </Field>
      {form.kind === 'webdav' && (
        <>
          <Field label={t.url} hint={t.urlHint}>
            <input value={form.url} spellCheck={false} placeholder="https://cloud.example.com/remote.php/dav/files/me/Iris/iris.sync" onChange={(e) => edit({ url: e.target.value })} />
          </Field>
          <div className="set-row">
            <Field label={t.user}>
              <input value={form.user} spellCheck={false} autoComplete="off" onChange={(e) => edit({ user: e.target.value })} />
            </Field>
            <Field label={t.password}>
              <input type="password" autoComplete="off" value={form.password} placeholder={secret('password')} onChange={(e) => edit({ password: e.target.value })} />
            </Field>
          </div>
        </>
      )}
      {form.kind === 'gist' && (
        <Field label={t.token} hint={t.tokenHint}>
          <input type="password" autoComplete="off" value={form.token} placeholder={secret('token')} onChange={(e) => edit({ token: e.target.value })} />
        </Field>
      )}
      {form.kind !== 'off' && (
        <>
          <Field label={t.passphrase} hint={t.passphraseHint}>
            <input type="password" autoComplete="new-password" value={form.passphrase} placeholder={secret('passphrase')} onChange={(e) => edit({ passphrase: e.target.value })} />
          </Field>
          <div className="set-row">
            <button type="button" className="set-btn set-btn--ghost" disabled={!config || status.phase === 'syncing'} onClick={() => void syncService.run(config)}>
              {t.now}
            </button>
            <span className="set-hint">{line}</span>
          </div>
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- search by meaning

export function SemanticToggle({ draft, patch }: Pick<Props, 'draft' | 'patch'>) {
  const t = useT().settings.memory;
  const state = useSemanticState();
  const detail =
    state.phase === 'downloading'
      ? t.semanticState.downloading(state.progress ?? 0)
      : state.phase === 'indexing'
        ? t.semanticState.indexing(state.indexed, state.total)
        : state.phase === 'ready'
          ? t.semanticState.ready(state.total)
          : state.phase === 'error'
            ? t.semanticState.error(state.error ?? '')
            : null;
  return (
    <>
      <label className="set-toggle">
        <input type="checkbox" checked={draft.semanticMemory} onChange={(e) => patch({ semanticMemory: e.target.checked })} />
        {t.semantic}
      </label>
      {draft.semanticMemory && detail && <p className="set-hint">{detail}</p>}
    </>
  );
}
