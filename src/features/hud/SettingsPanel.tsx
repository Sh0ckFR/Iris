import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { motion } from 'framer-motion';
import { isChatModel, listChatModels, listRealtimeModels } from '../../lib/modelCatalog';
import { OPENAI_VOICES, type Language, type Settings, type TtsEngine, type VoiceMode } from '../../lib/settings';
import type { SecretKey, Secrets } from '../../lib/secrets';
import { connectedProvider, hasRealtime, mediaProvider, PROVIDERS } from '../../lib/providers';
import { AccountSection, type AccountActions } from './AccountSetup';
import { VoicesManager } from './VoiceSetup';
import type { BenchResult } from '../assistant/llm';
import { skillStore, useSkills } from '../../lib/skills';
import { CloseIcon } from './icons';
import { memoryStore, useMemory } from '../../lib/memory';
import { parseMcpConfig, useMcpStatus } from '../assistant/mcp';
import { defaultPrice, type Price } from '../../lib/costs';
import { LANGUAGES, isUiLanguage, uiLocale, useT, type Messages } from '../../i18n';

const IMAGE_MODELS = ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'] as const;
/** Gemini's female voices offered for Iris (the API has more). */
const GEMINI_VOICES =['Sulafat', 'Kore', 'Aoede', 'Despina', 'Achernar', 'Zephyr'] as const;

/** Skills Iris created for itself. Changes apply immediately (they are not part of Save). */
function SkillsManager() {
  const t = useT().settings.skills;
  const skills = useSkills();
  const [open, setOpen] = useState<string | null>(null);
  if (skills.length === 0) return <p className="set-hint">{t.none}</p>;
  return (
    <ul className="set-skills">
      {[...skills]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((s) => (
          <li key={s.name} className={s.enabled ? '' : 'off'}>
            <div className="set-skill-head">
              <button type="button" className="set-skill-title" onClick={() => setOpen(open === s.name ? null : s.name)}>
                <strong>{s.title}</strong> <span className="set-hint">· {t.kinds[s.kind]} · skill_{s.name}</span>
              </button>
              <label className="set-toggle" title={t.enabled}>
                <input type="checkbox" checked={s.enabled} onChange={(e) => skillStore.update(s.name, { enabled: e.target.checked })} />
              </label>
            </div>
            <p className="set-hint">{s.description}</p>
            {open === s.name && (
              <div className="set-skill-body">
                {s.reason && <p className="set-hint">{t.createdBecause(s.reason)}</p>}
                {s.kind === 'script' && <pre>{s.script}</pre>}
                {s.kind === 'http' && s.http && <pre>{`${s.http.method} ${s.http.url}${s.http.body ? `\n\n${s.http.body}` : ''}`}</pre>}
                {s.kind === 'procedure' && <pre>{s.instructions}</pre>}
                {s.kind !== 'procedure' && (
                  <label className="set-toggle">
                    <input type="checkbox" checked={s.autoApprove} onChange={(e) => skillStore.update(s.name, { autoApprove: e.target.checked })} />
                    {t.autoApprove}
                  </label>
                )}
                <button type="button" className="set-link" onClick={() => skillStore.remove(s.name)}>
                  {t.remove}
                </button>
              </div>
            )}
          </li>
        ))}
    </ul>
  );
}

/** What Iris remembers about the user. Changes apply immediately (they are not part of Save). */
function MemoryManager() {
  const all = useT();
  const t = all.settings.memory;
  const memory = useMemory();
  const [confirm, setConfirm] = useState(false);
  return (
    <>
      {memory.facts.length === 0 ? (
        <p className="set-hint">{t.none}</p>
      ) : (
        <ul className="set-memory">
          {[...memory.facts].reverse().map((f) => (
            <li key={f.id}>
              <span>{f.text}</span>
              <span className="set-hint">
                {f.source === 'auto' ? t.noted : t.asked} · {new Date(f.createdAt).toLocaleDateString(uiLocale())}
              </span>
              <button type="button" className="set-link" onClick={() => memoryStore.removeFact(f.id)} aria-label={all.common.forget}>
                {all.common.forget}
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="set-hint">{t.archive(memory.journalEntries, memory.archivedMessages)}</p>
      {confirm ? (
        <span>
          {t.confirm}{' '}
          <button type="button" className="set-link" onClick={() => (memoryStore.clearAll(), setConfirm(false))}>
            {t.confirmYes}
          </button>{' '}
          <button type="button" className="set-link" onClick={() => setConfirm(false)}>
            {all.common.cancel}
          </button>
        </span>
      ) : (
        <button type="button" className="set-link" onClick={() => setConfirm(true)}>
          {t.clearAll}
        </button>
      )}
    </>
  );
}

const MCP_EXAMPLE = `{
  "mcpServers": {
    "files": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:/Users/me/Documents"]
    },
    "home": {
      "url": "http://my-server.local:8123/api/mcp",
      "headers": { "Authorization": "Bearer YOUR_TOKEN" }
    }
  }
}`;

/** MCP servers configuration (JSON, stored encrypted since it often holds tokens) + live status. */
function McpEditor({ saved, value, onChange }: { saved?: string; value?: string | null; onChange: (v: string | null) => void }) {
  const t = useT().settings.mcp;
  const statuses = useMcpStatus();
  const text = value === undefined ? (saved ?? '') : (value ?? '');
  const { error } = parseMcpConfig(text);
  return (
    <>
      <p className="set-hint">{t.intro}</p>
      <textarea
        className="set-code"
        rows={9}
        spellCheck={false}
        value={text}
        placeholder={MCP_EXAMPLE}
        onChange={(e) => onChange(e.target.value.trim() ? e.target.value : null)}
      />
      {error && <span className="set-warn">{error}</span>}
      {statuses.length > 0 && (
        <ul className="set-memory">
          {statuses.map((s) => (
            <li key={s.name}>
              <span>
                <strong>{s.name}</strong> · {t.state[s.state]}
                {s.state === 'connected' && ` · ${t.tools(s.tools)}`}
              </span>
              {s.error && <span className="set-warn">{s.error}</span>}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

interface Props extends AccountActions {
  settings: Settings;
  secrets: Secrets;
  vaultError: string | null;
  /** Applies instantly; the HUD persists keys to the vault in the background. */
  onSave: (settings: Settings, keys: Partial<Record<SecretKey, string | null>>) => void;
  /** Measures every configured model with the saved settings and keys. */
  onBenchmark: () => Promise<BenchResult[]>;
  onClose: () => void;
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

/** Password-style input for the backup providers: saved keys are never shown back. */
function KeyInput({ id, saved, value, onChange }: { id: SecretKey; saved: boolean; value: string | null | undefined; onChange: (v: string | null) => void }) {
  const all = useT();
  const t = all.settings.keys;
  const removing = value === null;
  return (
    <div className="set-key">
      <input
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={value ?? ''}
        placeholder={removing ? t.willBeRemoved : saved ? t.saved : t.paste}
        onChange={(e) => onChange(e.target.value)}
        aria-label={t.label(id)}
      />
      {saved && !removing && (
        <button type="button" className="set-link" onClick={() => onChange(null)}>
          {all.common.remove}
        </button>
      )}
    </div>
  );
}

/** Model list fetched from the provider, with a free-text escape hatch. */
function ModelPicker({
  label,
  apiKey,
  value,
  load,
  warning,
  onChange,
  emptyLabel,
  hint: extraHint,
}: {
  label: string;
  apiKey?: string;
  value: string;
  load: (apiKey: string) => Promise<string[]>;
  /** Returns a warning for a value that can't work here. */
  warning?: (value: string) => string | null;
  onChange: (model: string) => void;
  /** Makes "no model" a valid choice, shown with this label (e.g. "Same as the chat model"). */
  emptyLabel?: string;
  hint?: string;
}) {
  const t = useT().settings.models;
  const [models, setModels] = useState<string[] | null>(null);
  const [custom, setCustom] = useState(false);

  useEffect(() => {
    setModels(null);
    if (!apiKey) return;
    let alive = true;
    load(apiKey)
      .then((list) => alive && setModels(list))
      .catch(() => alive && setModels([]));
    return () => {
      alive = false;
    };
  }, [apiKey, load]);

  const warn = value ? warning?.(value) : null;
  const hint = warn ? <span className="set-warn">{warn}</span> : !apiKey ? t.saveKeyFirst : models === null ? t.loading : extraHint;

  const listed = models && models.length > 0 && !custom;
  return (
    <Field label={label} hint={hint}>
      {listed ? (
        <select
          value={models.includes(value) ? value : ''}
          onChange={(e) => (e.target.value === '__custom' ? setCustom(true) : onChange(e.target.value))}
        >
          {emptyLabel !== undefined && <option value="">{emptyLabel}</option>}
          {!models.includes(value) && (emptyLabel === undefined || value) && (
            <option value={emptyLabel === undefined ? '' : value}>{value ? t.notInList(value) : t.choose}</option>
          )}
          {models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
          <option value="__custom">{t.other}</option>
        </select>
      ) : (
        <input value={value} onChange={(e) => onChange(e.target.value.trim())} />
      )}
    </Field>
  );
}

function SpeedTest({ onBenchmark }: { onBenchmark: () => Promise<BenchResult[]> }) {
  const t = useT().settings.speed;
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<BenchResult[] | null>(null);
  const run = async () => {
    setRunning(true);
    setResults(null);
    try {
      setResults(await onBenchmark());
    } finally {
      setRunning(false);
    }
  };
  const fmt = (ms: number | null) => (ms === null ? '—' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
  return (
    <div className="set-bench">
      <button type="button" className="set-btn set-btn--ghost" onClick={run} disabled={running}>
        {running ? t.running : t.run}
      </button>
      {results && (
        <table>
          <thead>
            <tr>
              <th>{t.model}</th>
              <th>{t.firstWord}</th>
              <th>{t.fullAnswer}</th>
            </tr>
          </thead>
          <tbody>
            {results.map((r) => (
              <tr key={r.label}>
                <td>{r.label}</td>
                {r.error ? (
                  <td colSpan={2} className="set-warn">
                    {r.error}
                  </td>
                ) : (
                  <>
                    <td>{fmt(r.firstWordMs)}</td>
                    <td>{fmt(r.totalMs)}</td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <span className="set-hint">{t.note}</span>
    </div>
  );
}

/**
 * Money: a daily budget (one spoken warning past it) and the price of each model in use — the
 * built-in list prices are approximate, so any of them can be replaced here.
 */
function CostSettings({ draft, secrets, patch }: { draft: Settings; secrets: Secrets; patch: (p: Partial<Settings>) => void }) {
  const t = useT().settings.costs;
  const models = [
    ...new Set(
      PROVIDERS.filter((p) => secrets[p])
        .flatMap((p) => [draft.cloudModels[p], draft.builderModels[p]])
        .filter(Boolean),
    ),
  ];
  const setPrice = (model: string, field: keyof Price, value: string) => {
    const base = draft.prices[model] ?? defaultPrice(model) ?? { input: 0, cached: 0, output: 0 };
    const n = Number(value.replace(',', '.'));
    patch({ prices: { ...draft.prices, [model]: { ...base, [field]: Number.isFinite(n) ? n : 0 } } });
  };
  const reset = (model: string) => {
    const { [model]: _removed, ...rest } = draft.prices;
    patch({ prices: rest });
  };
  return (
    <div className="set-group">
      <h4>{t.title}</h4>
      <p className="set-note">{t.note}</p>
      <Field label={t.dailyBudget} hint={t.dailyBudgetHint}>
        <input
          type="number"
          min={0}
          step={0.5}
          value={draft.dailyBudgetEur || ''}
          placeholder="0"
          onChange={(e) => patch({ dailyBudgetEur: Math.max(0, Number(e.target.value) || 0) })}
        />
      </Field>
      {models.length > 0 && (
        <table className="set-prices">
          <thead>
            <tr>
              <th>{t.model}</th>
              <th>{t.input}</th>
              <th>{t.cache}</th>
              <th>{t.output}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {models.map((model) => {
              const custom = draft.prices[model];
              const price = custom ?? defaultPrice(model);
              return (
                <tr key={model}>
                  <td title={model}>{model}</td>
                  {(['input', 'cached', 'output'] as const).map((field) => (
                    <td key={field}>
                      <input type="number" min={0} step={0.01} value={price?.[field] ?? ''} placeholder="?" onChange={(e) => setPrice(model, field, e.target.value)} />
                    </td>
                  ))}
                  <td>
                    {custom && (
                      <button type="button" className="set-link" onClick={() => reset(model)}>
                        {t.reset}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <span className="set-hint">{t.unit}</span>
    </div>
  );
}

const chatWarning = (t: Messages) => (v: string) => (isChatModel(v) ? null : t.settings.models.chatWarning(v));
const realtimeWarning = (t: Messages) => (v: string) => (/realtime/i.test(v) ? null : t.settings.models.realtimeWarning(v));

export function SettingsPanel({ settings, secrets, vaultError, onSave, onConnect, onForget, onBenchmark, onClose }: Props) {
  const all = useT();
  const t = all.settings;
  const [draft, setDraft] = useState<Settings>(settings);
  const [keys, setKeys] = useState<Partial<Record<SecretKey, string | null>>>({});

  const patch = (p: Partial<Settings>) => setDraft((d) => ({ ...d, ...p }));
  /** A key typed in this panel (not yet saved) or the saved one. */
  const effectiveKey = (id: SecretKey) => (keys[id] === null ? undefined : keys[id] || secrets[id]);

  // Connecting a provider changes the saved settings at once: the draft follows, so Save keeps it.
  useEffect(() => {
    setDraft((d) => (d.cloudProvider === settings.cloudProvider ? d : { ...d, cloudProvider: settings.cloudProvider }));
  }, [settings.cloudProvider]);

  const save = () => {
    // Only send keys the user actually touched (empty input = unchanged).
    const changed = Object.fromEntries(
      Object.entries(keys)
        .filter(([, v]) => v === null || (v && v.trim()))
        .map(([k, v]) => [k, v === null ? null : v.trim()]),
    );
    onSave(draft, changed);
    onClose();
  };

  const main = connectedProvider(draft, secrets);
  const media = mediaProvider(draft, secrets);
  const provider = draft.cloudProvider;
  // Stable per provider: the picker refetches whenever this function changes.
  const loadChat = useCallback((apiKey: string) => listChatModels(provider, apiKey), [provider]);
  const honorificPreset = ['', 'Monsieur', 'Madame'].includes(draft.honorific);
  const backups = PROVIDERS.filter((p) => p !== main && p !== (main === 'anthropic' ? media : null));
  const natural = draft.ttsEngine === 'natural' && media;

  return (
    <motion.div className="set-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
      <motion.div
        className="set-panel"
        role="dialog"
        aria-label={t.title}
        initial={{ opacity: 0, y: 24, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 16, scale: 0.98 }}
        transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="set-header">
          <h2>{t.title}</h2>
          <button type="button" className="hud-icon-btn" onClick={onClose} aria-label={t.closeLabel}>
            <CloseIcon />
          </button>
        </header>

        <div className="set-body">
          {vaultError && <p className="set-error">{vaultError}</p>}

          <AccountSection settings={draft} secrets={secrets} onConnect={onConnect} onForget={onForget} />

          <section>
            <h3>{t.voice.title}</h3>
            <Field
              label={t.voice.irisVoice}
              hint={draft.ttsEngine === 'local' ? t.voice.localHint : media ? t.voice.naturalHint(all.account.providers[media].name) : t.voice.naturalMissing}
            >
              <select value={draft.ttsEngine} onChange={(e) => patch({ ttsEngine: e.target.value as TtsEngine })}>
                <option value="natural">{media ? t.voice.natural(all.account.providers[media].name) : t.voice.naturalNone}</option>
                <option value="local">{t.voice.local}</option>
              </select>
            </Field>
            {natural && media === 'openai' && (
              <Field label={t.voice.voiceChoice}>
                <select value={draft.voice} onChange={(e) => patch({ voice: e.target.value })}>
                  {OPENAI_VOICES.map((id) => (
                    <option key={id} value={id}>
                      {t.voice.voices[id] ?? id}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {natural && media === 'google' && (
              <Field label={t.voice.voiceChoice}>
                <select value={draft.geminiVoice} onChange={(e) => patch({ geminiVoice: e.target.value })}>
                  {GEMINI_VOICES.map((id) => (
                    <option key={id} value={id}>
                      {t.voice.geminiVoices[id] ?? id}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <Field label={t.voice.mainLanguage} hint={t.voice.mainLanguageHint}>
              <select value={draft.language} onChange={(e) => patch({ language: e.target.value as Language })}>
                <option value="fr">Français</option>
                <option value="en">English</option>
                <option value="multi">{t.voice.languageAuto}</option>
              </select>
            </Field>
            <label className="set-toggle">
              <input type="checkbox" checked={draft.speakReplies} onChange={(e) => patch({ speakReplies: e.target.checked })} />
              {t.voice.speakReplies}
            </label>
            <label className="set-toggle">
              <input type="checkbox" checked={draft.bargeIn} onChange={(e) => patch({ bargeIn: e.target.checked })} />
              {t.voice.bargeIn}
            </label>
            <p className="set-hint">{t.voice.note}</p>
          </section>

          <section>
            <h3>{all.voices.title}</h3>
            <VoicesManager voiceLock={draft.voiceLock} onVoiceLock={(voiceLock) => patch({ voiceLock })} />
          </section>

          <section>
            <h3>{t.interface.title}</h3>
            <Field label={t.interface.language} hint={t.interface.languageHint}>
              <select value={draft.uiLanguage} onChange={(e) => isUiLanguage(e.target.value) && patch({ uiLanguage: e.target.value })}>
                {Object.entries(LANGUAGES).map(([code, lang]) => (
                  <option key={code} value={code}>
                    {lang.name}
                  </option>
                ))}
              </select>
            </Field>
          </section>

          <section>
            <h3>{t.personality.title}</h3>
            <Field label={t.personality.address} hint={t.personality.addressHint}>
              <select
                value={honorificPreset ? draft.honorific : '__name'}
                onChange={(e) => patch({ honorific: e.target.value === '__name' ? draft.honorific || ' ' : e.target.value })}
              >
                <option value="">{t.personality.none}</option>
                <option value="Monsieur">{t.personality.monsieur}</option>
                <option value="Madame">{t.personality.madame}</option>
                <option value="__name">{t.personality.byName}</option>
              </select>
            </Field>
            {!honorificPreset && (
              <Field label={t.personality.firstName}>
                <input value={draft.honorific.trim()} onChange={(e) => patch({ honorific: e.target.value || ' ' })} />
              </Field>
            )}
            <label className="set-toggle">
              <input type="checkbox" checked={draft.autonomous} onChange={(e) => patch({ autonomous: e.target.checked })} />
              {t.voice.autonomous}
            </label>
            <label className="set-toggle">
              <input type="checkbox" checked={draft.bootGreeting} onChange={(e) => patch({ bootGreeting: e.target.checked })} />
              {t.personality.bootGreeting}
            </label>
            <label className="set-toggle">
              <input type="checkbox" checked={draft.uiSounds} onChange={(e) => patch({ uiSounds: e.target.checked })} />
              {t.personality.uiSounds}
            </label>
            <label className="set-toggle">
              <input type="checkbox" checked={draft.launchAtStartup} onChange={(e) => patch({ launchAtStartup: e.target.checked })} />
              {t.personality.launchAtStartup}
            </label>
          </section>

          <section>
            <h3>{t.memory.title}</h3>
            <label className="set-toggle">
              <input type="checkbox" checked={draft.autoMemory} onChange={(e) => patch({ autoMemory: e.target.checked })} />
              {t.memory.auto}
            </label>
            <label className="set-toggle">
              <input type="checkbox" checked={draft.resumeConversation} onChange={(e) => patch({ resumeConversation: e.target.checked })} />
              {t.memory.resume}
            </label>
            <MemoryManager />
          </section>

          <details className="set-advanced">
            <summary>
              <h3>{t.advanced.title}</h3>
              <span className="set-hint">{t.advanced.hint}</span>
            </summary>

            {main && (
              <div className="set-group">
                <h4>{t.brain.title}</h4>
                <label className="set-toggle">
                  <input
                    type="checkbox"
                    checked={draft.modelsAuto[provider]}
                    onChange={(e) => patch({ modelsAuto: { ...draft.modelsAuto, [provider]: e.target.checked } })}
                  />
                  {t.brain.autoModels}
                </label>
                <ModelPicker
                  key={provider}
                  label={t.brain.model}
                  apiKey={effectiveKey(provider)}
                  value={draft.cloudModels[provider]}
                  load={loadChat}
                  warning={chatWarning(all)}
                  onChange={(model) => patch({ cloudModels: { ...draft.cloudModels, [provider]: model }, modelsAuto: { ...draft.modelsAuto, [provider]: false } })}
                />
                <ModelPicker
                  key={`builder-${provider}`}
                  label={t.brain.builderModel}
                  apiKey={effectiveKey(provider)}
                  value={draft.builderModels[provider]}
                  load={loadChat}
                  warning={chatWarning(all)}
                  emptyLabel={t.brain.sameAsConversation}
                  hint={t.brain.builderHint}
                  onChange={(model) => patch({ builderModels: { ...draft.builderModels, [provider]: model }, modelsAuto: { ...draft.modelsAuto, [provider]: false } })}
                />
                <SpeedTest onBenchmark={onBenchmark} />
              </div>
            )}

            <div className="set-group">
              <h4>{t.advanced.premium}</h4>
              {hasRealtime(secrets) ? (
                <>
                  <Field label={t.voice.mode} hint={draft.voiceMode === 'economy' ? t.voice.economyHint : t.voice.realtimeHint}>
                    <select value={draft.voiceMode} onChange={(e) => patch({ voiceMode: e.target.value as VoiceMode })}>
                      <option value="economy">{t.voice.economy}</option>
                      <option value="realtime">{t.voice.premium}</option>
                    </select>
                  </Field>
                  {draft.voiceMode === 'realtime' && (
                    <ModelPicker
                      label={t.voice.realtimeModel}
                      apiKey={effectiveKey('openai')}
                      value={draft.realtimeModel}
                      load={listRealtimeModels}
                      warning={realtimeWarning(all)}
                      hint={t.voice.realtimeModelHint}
                      onChange={(realtimeModel) => patch({ realtimeModel })}
                    />
                  )}
                </>
              ) : (
                <p className="set-hint">{t.advanced.premiumNeedsOpenai}</p>
              )}
            </div>

            <div className="set-group">
              <h4>{t.images.title}</h4>
              {media === 'openai' ? (
                <>
                  <Field label={t.images.model} hint={t.images.hint}>
                    <select
                      value={(IMAGE_MODELS as readonly string[]).includes(draft.imageModel) ? draft.imageModel : '__custom'}
                      onChange={(e) => e.target.value !== '__custom' && patch({ imageModel: e.target.value })}
                    >
                      <option value="gpt-image-2.5-flare">gpt-image-2.5-flare — {t.images.flare}</option>
                      <option value="gpt-image-2.5-sunburst">gpt-image-2.5-sunburst — {t.images.sunburst}</option>
                      <option value="__custom">{t.images.other}</option>
                    </select>
                  </Field>
                  {!(IMAGE_MODELS as readonly string[]).includes(draft.imageModel) && (
                    <Field label={t.images.modelId}>
                      <input value={draft.imageModel} onChange={(e) => patch({ imageModel: e.target.value.trim() })} />
                    </Field>
                  )}
                </>
              ) : (
                <p className="set-hint">{media === 'google' ? t.images.gemini : t.images.none}</p>
              )}
            </div>

            {main && backups.length > 0 && (
              <div className="set-group">
                <h4>{t.advanced.backup}</h4>
                <p className="set-hint">{t.advanced.backupHint}</p>
                {backups.map((p) => (
                  <Field key={p} label={t.keys.label(all.account.providers[p].name)}>
                    <KeyInput id={p} saved={!!secrets[p]} value={keys[p]} onChange={(v) => setKeys((k) => ({ ...k, [p]: v }))} />
                  </Field>
                ))}
              </div>
            )}

            <div className="set-group">
              <h4>{t.voice.vocabulary}</h4>
              <Field label={t.voice.vocabulary} hint={t.voice.vocabularyHint}>
                <input value={draft.vocabulary} placeholder={t.voice.vocabularyPlaceholder} onChange={(e) => patch({ vocabulary: e.target.value })} />
              </Field>
            </div>

            <CostSettings draft={draft} secrets={secrets} patch={patch} />

            <div className="set-group">
              <h4>{t.internet.title}</h4>
              <Field label={t.internet.tavilyKey} hint={t.internet.tavilyHint}>
                <KeyInput id="tavily" saved={!!secrets.tavily} value={keys.tavily} onChange={(v) => setKeys((k) => ({ ...k, tavily: v }))} />
              </Field>
            </div>

            <div className="set-group">
              <h4>{t.mcp.title}</h4>
              <McpEditor saved={secrets.mcp} value={keys.mcp} onChange={(v) => setKeys((k) => ({ ...k, mcp: v }))} />
            </div>

            <div className="set-group">
              <h4>{t.skills.title}</h4>
              <SkillsManager />
            </div>
          </details>
        </div>

        <footer className="set-footer">
          <button type="button" className="set-btn set-btn--ghost" onClick={onClose}>
            {all.common.cancel}
          </button>
          <button type="button" className="set-btn" onClick={save}>
            {all.common.save}
          </button>
        </footer>
      </motion.div>
    </motion.div>
  );
}
