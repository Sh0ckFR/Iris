import { useCallback, useEffect, useRef, useState, type DragEvent as ReactDragEvent } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { benchmarkBrains, brainChain } from '../assistant/llm';
import { speechLang } from '../assistant/tts';
import { ApprovalCard } from './ApprovalCard';
import { useSettings, type CloudProvider, type Settings } from '../../lib/settings';
import { listChatModels } from '../../lib/modelCatalog';
import { hasRealtime } from '../../lib/providers';
import { voiceStore } from '../../lib/voiceprint';
import { applyModelPicks, pickModelsForKeys, useUnavailableModels } from '../../lib/modelDefaults';
import { useSecrets, type SecretKey } from '../../lib/secrets';
import { useAssistant } from '../assistant/useAssistant';
import { Orb } from './Orb';
import { IrisLogo } from './IrisLogo';
import { GlassPanel } from './GlassPanel';
import { ConversationLog } from './ConversationLog';
import { KnowledgeGraph } from './KnowledgeGraph';
import { BriefingView } from './BriefingView';
import { VisualView } from './VisualView';
import { setPanelHidden, useHiddenPanels } from './panelVisibility';
import { ControlDock, statusLine } from './ControlDock';
import { emitTo, listen } from '@tauri-apps/api/event';
import { MINI_HELLO_EVENT, MINI_STATUS_EVENT, type MiniStatus } from '../../lib/miniWindow';
import { SettingsPanel } from './SettingsPanel';
import { SetupWizard } from './SetupWizard';
import { DashboardPanel } from './DashboardPanel';
import { dashboardStore, useDashboards } from '../../lib/dashboards';
import { syncAutostart } from '../../lib/autostart';
import { Telemetry } from './Telemetry';
import { BootSequence } from './BootSequence';
import { playSfx } from '../assistant/sfx';
import { prepareAttachment, type Attachment } from '../assistant/documents';
import { CloseIcon, GearIcon, TrashIcon } from './icons';
import { invoke } from '@tauri-apps/api/core';
import { setUiLanguage, useT } from '../../i18n';
import './HUD.css';

/** The boot sequence and spoken greeting play once per app session (not on every re-mount). */
let bootedThisSession = false;

interface Toast {
  text: string;
  tone: 'info' | 'ok' | 'error';
}

export function IrisHUD() {
  const root = useRef<HTMLDivElement>(null);
  const [settings, updateSettings] = useSettings();
  const vault = useSecrets();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const hiddenPanels = useHiddenPanels();
  // Pinned dashboards come back at launch (the one that was open is shown again).
  const dashboards = useDashboards();
  useEffect(() => void dashboardStore.load(), []);
  // The recognised voices (Settings, and the check of who is speaking).
  useEffect(() => void voiceStore.load(), []);
  // Launch at startup follows its setting (checked at each launch too).
  useEffect(() => void syncAutostart(settings.launchAtStartup), [settings.launchAtStartup]);
  const t = useT();
  // The interface language follows its setting, the tray menu included.
  useEffect(() => {
    setUiLanguage(settings.uiLanguage);
  }, [settings.uiLanguage]);
  useEffect(() => {
    void invoke('set_tray_labels', t.tray).catch(() => {});
  }, [t]);
  const [toast, setToast] = useState<Toast | null>(null);
  const openSettings = useCallback(() => setSettingsOpen(true), []);

  const assistant = useAssistant({ settings, secrets: vault.secrets, onNeedSettings: openSettings });
  const { phase, cancel, pendingAction, respondToAction, greet } = assistant;

  // ---- Documents: 📎 button or drag & drop anywhere on the window.
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);

  const attach = useCallback(async (files: File[]) => {
    const errors: string[] = [];
    const ready: Attachment[] = [];
    for (const file of files) {
      try {
        ready.push(await prepareAttachment(file));
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (ready.length) setAttachments((prev) => [...prev, ...ready]);
    if (errors.length) setToast({ text: errors.join(' · '), tone: 'error' });
  }, []);

  const sendMessage = useCallback(
    (text: string) => {
      void assistant.send(text, attachments);
      setAttachments([]);
    },
    [assistant, attachments],
  );

  const dropHandlers = {
    onDragEnter: (e: ReactDragEvent) => {
      if (!e.dataTransfer.types.includes('Files')) return;
      e.preventDefault();
      dragDepth.current++;
      setDragging(true);
    },
    onDragOver: (e: ReactDragEvent) => {
      if (e.dataTransfer.types.includes('Files')) e.preventDefault();
    },
    onDragLeave: () => {
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragging(false);
    },
    onDrop: (e: ReactDragEvent) => {
      e.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      void attach(Array.from(e.dataTransfer.files));
    },
  };

  // The first launch starts with the setup; the boot sequence plays once it's done.
  const [booting, setBooting] = useState(!bootedThisSession && settings.setupDone);
  useEffect(() => {
    if (booting) playSfx('boot');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const finishBoot = useCallback(() => {
    if (bootedThisSession) return;
    bootedThisSession = true;
    setBooting(false);
    if (settings.bootGreeting) void greet();
  }, [greet, settings.bootGreeting]);

  const finishSetup = useCallback(() => {
    updateSettings({ setupDone: true });
    setBooting(true);
    playSfx('boot');
  }, [updateSettings]);

  // Set up, but no AI account any more (disconnected): open Settings to connect one.
  useEffect(() => {
    if (settings.setupDone && vault.status === 'ready' && !vault.secrets.openai && !vault.secrets.anthropic && !vault.secrets.google) {
      setSettingsOpen(true);
    }
  }, [settings.setupDone, vault.status, vault.secrets]);

  // The premium voice mode needs OpenAI: without its key, back to the economy mode.
  useEffect(() => {
    if (vault.status === 'ready' && settings.voiceMode === 'realtime' && !hasRealtime(vault.secrets)) updateSettings({ voiceMode: 'economy' });
  }, [vault.status, vault.secrets, settings.voiceMode, updateSettings]);

  /**
   * Connecting a provider (first-launch setup and Settings): the key is checked by listing the
   * models it gives access to, then kept at once (the encrypted vault write follows in the background).
   */
  const connect = useCallback(
    async (provider: CloudProvider, key: string, main: boolean) => {
      const models = await listChatModels(provider, key);
      if (models.length === 0) throw new Error(t.account.noModels);
      vault.save({ [provider]: key }).catch((e) => setToast({ text: t.hud.keysNotSaved(String(e)), tone: 'error' }));
      if (main) updateSettings((prev) => ({ cloudProvider: provider, modelsAuto: { ...prev.modelsAuto, [provider]: true } }));
    },
    [vault, updateSettings, t],
  );
  const forget = useCallback(
    (keys: SecretKey[]) => {
      vault.save(Object.fromEntries(keys.map((k) => [k, null]))).catch((e) => setToast({ text: t.hud.keysNotSaved(String(e)), tone: 'error' }));
    },
    [vault, t],
  );

  // A model found unavailable (refused by its provider) makes the automatic choice run again.
  const unavailableModels = useUnavailableModels();
  // Models follow the saved keys: the newest inexpensive one each key can use for the
  // conversation, a stronger one for visuals (unless chosen by hand in Settings).
  useEffect(() => {
    if (vault.status !== 'ready') return;
    let alive = true;
    void pickModelsForKeys(vault.secrets).then((picks) => {
      if (alive) updateSettings((prev) => applyModelPicks(prev, vault.secrets, picks));
    });
    return () => {
      alive = false;
    };
    // Models and provider too: a Settings draft saved over an automatic pick is corrected.
  }, [vault.status, vault.secrets, settings.modelsAuto, settings.cloudModels, settings.builderModels, settings.cloudProvider, updateSettings, unavailableModels]);

  const benchmark = useCallback(
    () => benchmarkBrains(brainChain(settings, vault.secrets), speechLang(settings.language)),
    [settings, vault.secrets],
  );

  // Success toasts fade on their own; errors stay until dismissed.
  useEffect(() => {
    if (toast?.tone !== 'ok') return;
    const timer = window.setTimeout(() => setToast(null), 2500);
    return () => window.clearTimeout(timer);
  }, [toast]);

  /** Settings apply instantly; the encrypted vault write happens in the background. */
  const saveSettings = useCallback(
    (next: Settings, keys: Partial<Record<SecretKey, string | null>>) => {
      updateSettings(next);
      if (Object.keys(keys).length === 0) return;
      setToast({ text: t.hud.encryptingKeys, tone: 'info' });
      vault
        .save(keys)
        .then(() => setToast({ text: t.hud.keysSaved, tone: 'ok' }))
        .catch((e) =>
          setToast({ text: t.hud.keysNotSaved(String(e)), tone: 'error' }),
        );
    },
    [updateSettings, vault, t],
  );

  // The mini window (shown while this one is closed) displays Iris's state and last words.
  const lastReply = [...assistant.messages].reverse().find((m) => m.role === 'assistant' && m.content)?.content ?? '';
  const miniStatus: MiniStatus = {
    phase,
    status: statusLine({
      phase,
      activity: assistant.activity,
      running: assistant.tasks.filter((t) => t.status === 'running').length,
      voiceActive: assistant.voiceActive,
      wake: assistant.wakeStatus,
      voiceReady: assistant.voiceReady,
    }),
    reply: lastReply.length > 220 ? `${lastReply.slice(0, 219)}…` : lastReply,
  };
  const miniStatusRef = useRef(miniStatus);
  miniStatusRef.current = miniStatus;
  const miniKey = JSON.stringify(miniStatus);
  useEffect(() => {
    void emitTo('mini', MINI_STATUS_EVENT, miniStatusRef.current).catch(() => {});
  }, [miniKey]);
  useEffect(() => {
    const off = listen(MINI_HELLO_EVENT, () => void emitTo('mini', MINI_STATUS_EVENT, miniStatusRef.current).catch(() => {}));
    return () => void off.then((f) => f());
  }, []);

  // Esc = cut Iris off (voice only); the microphone itself is always on.
  // With an approval card open: Enter = allow, Esc = decline.
  const { stopSpeaking } = assistant;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (settingsOpen) {
        if (e.key === 'Escape') setSettingsOpen(false);
        return;
      }
      if (pendingAction) {
        if (e.key === 'Escape') {
          e.preventDefault();
          respondToAction(false);
          return;
        }
        // Focused buttons handle Enter themselves (Enter on "Decline" must decline).
        if (e.key === 'Enter' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLButtonElement)) {
          e.preventDefault();
          respondToAction(true);
          return;
        }
      }
      if (e.key === 'Escape') stopSpeaking();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [settingsOpen, stopSpeaking, pendingAction, respondToAction]);

  return (
    <div ref={root} className={`hud hud--${phase}`} {...dropHandlers}>
      <div className="hud-grid" aria-hidden />
      <AnimatePresence>
        {dragging && (
          <motion.div className="hud-drop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <p>{t.hud.dropTitle}</p>
            <span>{t.hud.dropFormats}</span>
          </motion.div>
        )}
      </AnimatePresence>
      <Orb phase={phase} levelRef={assistant.levelRef} />

      <header className="hud-topbar">
        <div className="hud-brand">
          <IrisLogo size={30} phase={phase} />
          I.R.I.S
        </div>
        {hiddenPanels.size > 0 && (
          <div className="hud-restore">
            {[...hiddenPanels].map((id) => (
              <button key={id} type="button" onClick={() => setPanelHidden(id, false)} title={t.hud.showPanelAgain}>
                + {t.hud.panels[id as keyof typeof t.hud.panels] ?? id}
              </button>
            ))}
          </div>
        )}
        <div className={`hud-badge${assistant.hasBrain ? '' : ' hud-badge--warn'}`} title={t.hud.modelBadgeTitle}>
          {assistant.brainLabel ?? t.hud.noModel}
        </div>
        <button type="button" className="hud-icon-btn" onClick={openSettings} aria-label={t.hud.settings}>
          <GearIcon />
        </button>
      </header>

      <Telemetry
        phase={phase}
        brain={assistant.brainLabel}
        voiceReady={assistant.voiceReady}
        voiceActive={assistant.voiceActive}
        webSearch={!!vault.secrets.tavily}
        wake={assistant.wakeStatus}
        voiceMode={assistant.voiceMode}
      />

      <AnimatePresence>
        {!hiddenPanels.has('conversation') && (
          <GlassPanel
            key="conversation"
            id="conversation"
            title={t.hud.panels.conversation}
            className="hud-panel--log"
            bounds={root}
            delay={0.1}
            actions={
              <>
                {assistant.messages.length > 0 && (
                  <button type="button" className="hud-icon-btn hud-icon-btn--sm" onClick={assistant.clear} aria-label={t.hud.clearConversation}>
                    <TrashIcon width={15} height={15} />
                  </button>
                )}
                <button type="button" className="hud-icon-btn hud-icon-btn--sm" onClick={() => setPanelHidden('conversation', true)} aria-label={t.hud.hideConversation}>
                  <CloseIcon width={14} height={14} />
                </button>
              </>
            }
          >
            <ConversationLog
              messages={assistant.messages}
              phase={phase}
              activeBriefingId={assistant.briefing?.id ?? null}
              onShowBriefing={assistant.showBriefing}
            />
          </GlassPanel>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {!hiddenPanels.has('knowledge') && (
          <GlassPanel
            key="knowledge"
            id="knowledge"
            title={t.hud.panels.knowledge}
            className="hud-panel--graph"
            bounds={root}
            delay={0.2}
            actions={
              <button type="button" className="hud-icon-btn hud-icon-btn--sm" onClick={() => setPanelHidden('knowledge', true)} aria-label={t.hud.hideKnowledge}>
                <CloseIcon width={14} height={14} />
              </button>
            }
          >
            <KnowledgeGraph />
          </GlassPanel>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {assistant.briefing && (
          <GlassPanel
            key="briefing"
            id="briefing"
            title={assistant.briefing.heading}
            className="hud-panel--briefing"
            bounds={root}
            actions={
              <button type="button" className="hud-icon-btn hud-icon-btn--sm" onClick={assistant.closeBriefing} aria-label={t.hud.closeBriefing}>
                <CloseIcon width={14} height={14} />
              </button>
            }
          >
            <BriefingView briefing={assistant.briefing} />
          </GlassPanel>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {assistant.visual && (
          <GlassPanel
            key="visual"
            id="visual"
            title={assistant.visual.heading}
            className="hud-panel--visual"
            bounds={root}
            actions={
              <button type="button" className="hud-icon-btn hud-icon-btn--sm" onClick={assistant.closeVisual} aria-label={t.hud.closeVisual}>
                <CloseIcon width={14} height={14} />
              </button>
            }
          >
            <VisualView key={assistant.visual.id} visual={assistant.visual} />
          </GlassPanel>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {dashboards.open && (
          <GlassPanel
            key="dashboard"
            id="dashboard"
            title={dashboards.dashboards.find((d) => d.id === dashboards.open)?.name ?? t.hud.panels.dashboard}
            className="hud-panel--dashboard"
            bounds={root}
            actions={
              <button type="button" className="hud-icon-btn hud-icon-btn--sm" onClick={() => dashboardStore.open(null)} aria-label={t.hud.closeDashboard}>
                <CloseIcon width={14} height={14} />
              </button>
            }
          >
            <DashboardPanel />
          </GlassPanel>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {toast && (
          <motion.div
            className={`hud-toast hud-toast--${toast.tone}`}
            role="status"
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
          >
            {toast.tone === 'info' && <span className="hud-spinner" aria-hidden />}
            <span>{toast.text}</span>
            {toast.tone === 'error' && (
              <button type="button" className="hud-icon-btn hud-icon-btn--sm" onClick={() => setToast(null)} aria-label={t.common.dismiss}>
                <CloseIcon width={14} height={14} />
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {assistant.notice && (
          <motion.div
            className="hud-notice"
            role="status"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
          >
            <span>{assistant.notice}</span>
            <button type="button" className="hud-icon-btn hud-icon-btn--sm" onClick={assistant.dismissNotice} aria-label={t.common.dismiss}>
              <CloseIcon width={14} height={14} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {pendingAction && (
          <ApprovalCard key={pendingAction.id} request={pendingAction} queued={assistant.pendingCount - 1} onRespond={respondToAction} />
        )}
      </AnimatePresence>

      <ControlDock
        phase={phase}
        voiceActive={assistant.voiceActive}
        speaking={assistant.speaking}
        activity={assistant.activity}
        voiceReady={assistant.voiceReady}
        wake={assistant.wakeStatus}
        tasks={assistant.tasks}
        onCancelTask={assistant.cancelTask}
        onCancelAll={cancel}
        onStopSpeaking={assistant.stopSpeaking}
        attachments={attachments}
        onAttach={(files) => void attach(files)}
        onRemoveAttachment={(id) => setAttachments((prev) => prev.filter((a) => a.id !== id))}
        onSend={sendMessage}
      />

      <AnimatePresence>
        {settingsOpen && (
          <SettingsPanel
            settings={settings}
            secrets={vault.secrets}
            vaultError={vault.error}
            onSave={saveSettings}
            onConnect={connect}
            onForget={forget}
            onBenchmark={benchmark}
            onClose={() => setSettingsOpen(false)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {!settings.setupDone && vault.status !== 'loading' && (
          <SetupWizard
            key="setup"
            settings={settings}
            secrets={vault.secrets}
            onChange={updateSettings}
            onConnect={connect}
            onForget={forget}
            onFinish={finishSetup}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {booting && <BootSequence key="boot" onDone={finishBoot} brain={assistant.brainLabel} voice={settings.realtimeModel} />}
      </AnimatePresence>
    </div>
  );
}
