import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ModelMessage, Tool, ToolSet } from 'ai';
import { emitTo } from '@tauri-apps/api/event';
import type { Settings } from '../../lib/settings';
import type { Secrets } from '../../lib/secrets';
import { hasRealtime, mediaProvider } from '../../lib/providers';
import { knowledgeStore } from '../../lib/knowledge';
import { announceSentence } from '../../lib/narration';
import { MINI_LEVEL_EVENT } from '../../lib/miniWindow';
import { DESKTOP_ONLY_TOOLS, IS_MOBILE } from '../../lib/platform';
import { isPanelHidden, setPanelHidden } from '../hud/panelVisibility';
import { brainChain, describeError, streamReply, systemPrompt, toolGuidance, turnContext, VOICE_NOTE, type BrainRole } from './llm';
import { definitionTokens, groupOf, selectTools, type ToolGroup } from './toolGroups';
import { acknowledgement, allAcknowledgements } from './acknowledgements';
import { RealtimeSession } from './realtime';
import { Speaker, speechLang, type SpeakerConfig } from './tts';
import { playSfx, setSfxEnabled, withToolSounds } from './sfx';
import { splitSentences } from './audio';
import { detectLanguage } from './language';
import { matchLocalCommand, createTimerTools } from './localCommands';
import { guardUntrusted } from './untrusted';
import { createTools, type Briefing, type ToolHooks, type VisualBriefing } from './tools';
import { createOsTools, describeOsContext, loadOsContext, type ActionRequest } from './osTools';
import { createMediaTools } from './mediaTools';
import { createSkillTools } from './skillTools';
import { createDocumentTools, documentNote, DOCUMENT_FOLLOW_UPS, userContent, type Attachment } from './documents';
import { createVisualTools } from './visualTools';
import { createWidgetTools } from './widgetTools';
import { createAlertTools } from './alertTools';
import { createScheduleTools } from './scheduleTools';
import { createPanelTools, type PanelHooks } from './panelTools';
import { createSessionTools } from './sessionTools';
import { createMemoryTools } from './memoryTools';
import { createPersonalTools } from './personalTools';
import { useProactivity, markActivity } from './useProactivity';
import { parseCalendarUrls } from '../../lib/calendar';
import { parseMailAccount } from '../../lib/mail';
import { memoryStore } from '../../lib/memory';
import { semanticMemory } from '../../lib/semantic';
import { parseSyncConfig, syncService } from '../../lib/sync';
import { recordVoiceLatency } from '../../lib/latency';
import { createComputerTools } from './computerTools';
import { createScreenTools, SCREEN_SYSTEM } from './screenTools';
import { clipMcpResult, configureMcp, mcpTools } from './mcp';
import { useApprovals } from './useApprovals';
import { useBackgroundJobs } from './useBackgroundJobs';
import { useLocalCommands } from './useLocalCommands';
import { useLocalVoice, type VoiceInput } from './useLocalVoice';
import { useConversationMemory } from './useConversationMemory';
import {
  ACK_AFTER_MS,
  EN_HONORIFIC,
  FINISHED_TASK_TTL_MS,
  FOLLOW_UP_MS,
  GROUP_MEMORY,
  HANDS_FREE_IDLE_MS,
  HISTORY_LIMIT,
  SLOW_TOOLS,
  greetingText,
  isBackgroundTask,
  micErrorMessage,
  parseVocabulary,
  toolLabel,
  toolTaskTitle,
  uid,
  upsertBriefing,
  type ChatMessage,
  type Phase,
  type Task,
} from './assistantShared';

export type { ChatMessage, Phase, Task } from './assistantShared';
export { greetingText, parseVocabulary } from './assistantShared';

interface Options {
  settings: Settings;
  secrets: Secrets;
  /** Called when a feature needs a key the user hasn't entered yet. */
  onNeedSettings: () => void;
}

/**
 * Iris's brain on the HUD side. Two ways to talk to her:
 *  - a request (typed, or spoken and transcribed on this computer): a task answered by the chosen
 *    brain (OpenAI / Anthropic / Gemini, with fallbacks), with only the tools it needs. Tasks run
 *    in parallel; their spoken replies take turns;
 *  - the premium voice: a live OpenAI Realtime speech-to-speech session with the same persona and
 *    tools; each tool it runs shows up as a task.
 * The rest lives in its own hooks: approvals (useApprovals), timers / alerts / budget
 * (useBackgroundJobs), answers without AI (useLocalCommands), always-on listening
 * (useLocalVoice), and the conversation's memory (useConversationMemory).
 */
export function useAssistant({ settings, secrets, onNeedSettings }: Options) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [activeBrain, setActiveBrain] = useState<string | null>(null);
  const [briefing, setBriefing] = useState<Briefing | null>(null);
  /** What Iris built (page, chart, document…), in its own panel next to the info cards. */
  const [visual, setVisual] = useState<VisualBriefing | null>(null);
  const [voiceActive, setVoiceActive] = useState(false);
  const [voicePhase, setVoicePhase] = useState<Phase>('listening');
  const [speaking, setSpeaking] = useState(false);
  /** Read every frame by the eye — deliberately not React state. */
  const levelRef = useRef(0);
  /** A reply is being read aloud (its voice drives the eye, not the microphone). */
  const ttsBusyRef = useRef(false);
  const levelSentAt = useRef(0);
  /** Voice level for the eye, and (~12 times a second) for the mini window's eye. */
  const setLevel = (level: number) => {
    levelRef.current = level;
    const now = performance.now();
    if (now - levelSentAt.current < 80) return;
    levelSentAt.current = now;
    void emitTo('mini', MINI_LEVEL_EVENT, level).catch(() => {});
  };
  /**
   * Economy voice: a sentence *started* in this window counts as a follow-up (no name needed).
   * It opens when Iris stops talking.
   */
  const followUpFromRef = useRef(0);
  const followUpUntilRef = useRef(0);
  /** "Stop listening" was asked: no follow-up window after the acknowledgement. */
  const standbyRequestedRef = useRef(false);
  /** Sentences Iris said in the last seconds (to tell an interruption from her own echo). */
  const spokenRef = useRef<{ text: string; at: number }[]>([]);
  /** Tool groups used recently → exchanges they stay available (see toolGroups.ts). */
  const recentGroupsRef = useRef(new Map<ToolGroup, number>());
  const rememberGroups = useCallback((used: Set<ToolGroup>) => {
    const recent = recentGroupsRef.current;
    recent.forEach((left, group) => (left <= 1 ? recent.delete(group) : recent.set(group, left - 1)));
    used.forEach((group) => recent.set(group, GROUP_MEMORY));
  }, []);

  // Latest values for async callbacks without re-creating them.
  const live = useRef({ messages, settings, secrets, onNeedSettings, tasks, briefing, visual });
  live.current = { messages, settings, secrets, onNeedSettings, tasks, briefing, visual };

  const controllers = useRef(new Map<string, AbortController>());
  /** Documents attached to user messages (by message id), re-sent as context for follow-ups. */
  const attachmentsRef = useRef(new Map<string, Attachment[]>());
  const sessionRef = useRef<RealtimeSession | null>(null);
  /** Latest visual (kept when its panel is closed, for "change the colours" follow-ups). */
  const visualRef = useRef<VisualBriefing | null>(null);
  /** A visual the user closed while it was still streaming must not pop up again. */
  const closedVisualId = useRef<string | null>(null);
  /** Latest info card, so "show the news again" can reopen the briefing panel. */
  const lastBriefingRef = useRef<Briefing | null>(null);

  // ------------------------------------------------------------------ cards and panels

  /** Panel visibility for arrange_panels (synchronous: several actions run in one call). */
  const panelHooks: PanelHooks = useMemo(
    () => ({
      isVisible: (panel) =>
        panel === 'briefing' ? !!live.current.briefing : panel === 'visual' ? !!live.current.visual : !isPanelHidden(panel),
      setVisible: (panel, visible) => {
        const fr = navigator.language.startsWith('fr');
        if (panel === 'conversation' || panel === 'knowledge') {
          setPanelHidden(panel, !visible);
          return null;
        }
        if (panel === 'briefing') {
          const next = visible ? lastBriefingRef.current : null;
          if (visible && !next) return fr ? 'aucune carte d’information à afficher pour l’instant' : 'no info card to show yet';
          live.current.briefing = next;
          setBriefing(next);
          return null;
        }
        const next = visible ? visualRef.current : null;
        if (visible && !next) return fr ? 'aucun visuel créé pour l’instant' : 'nothing built yet';
        closedVisualId.current = visible ? null : (live.current.visual?.id ?? null);
        live.current.visual = next;
        setVisual(next);
        return null;
      },
    }),
    [],
  );

  /** Shows a card: visuals go to the Visual panel, live data to the Briefing panel. */
  const showCard = useCallback((b: Briefing) => {
    if (b.kind !== 'visual') {
      lastBriefingRef.current = b;
      return setBriefing(b);
    }
    visualRef.current = b;
    if (closedVisualId.current !== b.id) setVisual(b);
  }, []);
  /** Card chip clicked in the conversation. */
  const showBriefing = useCallback(
    (b: Briefing) => {
      if (b.kind === 'visual') closedVisualId.current = null;
      showCard(b);
    },
    [showCard],
  );
  const closeVisual = useCallback(() => {
    setVisual((v) => {
      closedVisualId.current = v?.id ?? null;
      return null;
    });
  }, []);

  // ------------------------------------------------------------------ language and voice output

  /** Language the user last spoke or typed in (null until it can be told). */
  const userLangRef = useRef<'fr' | 'en' | null>(null);
  /** Remembers the user's language from a message, when it is clear enough. */
  const noteUserLanguage = (text: string) => {
    const detected = detectLanguage(text);
    if (detected) userLangRef.current = detected;
    return userLangRef.current;
  };
  /** The user's language for a local reply: the latest one heard, else Settings. */
  const replyLang = (text?: string): 'fr' | 'en' =>
    (text && detectLanguage(text)) || (userLangRef.current === 'en' || userLangRef.current === 'fr' ? userLangRef.current : speechLang(live.current.settings.language));
  /** "Monsieur" / "sir" (Settings), for the few lines Iris says without the AI. */
  const honorific = (lang: 'fr' | 'en') => {
    const h = live.current.settings.honorific.trim();
    return lang === 'en' ? (EN_HONORIFIC[h.toLowerCase()] ?? h) : h;
  };

  /** Spoken requests waiting for their first sound: task id → when the user stopped talking. */
  const heardAtRef = useRef(new Map<string, number>());
  const speaker = useMemo(
    () =>
      new Speaker({
        // Each sentence as it is heard: maps follow the places Iris names (tours).
        onSentence: (text, channel) => {
          const heardAt = heardAtRef.current.get(channel);
          if (heardAt) {
            heardAtRef.current.delete(channel);
            recordVoiceLatency(Date.now() - heardAt);
          }
          announceSentence(text);
          // What she said lately: an interruption is told apart from her own voice's echo.
          spokenRef.current = [...spokenRef.current.filter((s) => Date.now() - s.at < 20_000), { text, at: Date.now() }];
        },
        onLevel: (level) => {
          if (!sessionRef.current) setLevel(level);
        },
        onBusy: (busy) => {
          ttsBusyRef.current = busy;
          // Follow-up window (economy voice): when Iris has just asked a question, the user may
          // answer without her name — unless she was just sent to standby. Otherwise, her name.
          const last = spokenRef.current[spokenRef.current.length - 1];
          const asked = !!last && Date.now() - last.at < 60_000 && /[?？؟]["»”’)\s]*$/.test(last.text);
          followUpFromRef.current = Date.now();
          followUpUntilRef.current = busy || standbyRequestedRef.current || !asked ? 0 : Date.now() + FOLLOW_UP_MS;
          if (!busy) standbyRequestedRef.current = false;
          setSpeaking(busy);
        },
        onError: (error) => setNotice(error.message),
      }),
    [],
  );

  useEffect(
    () => () => {
      speaker.dispose();
      sessionRef.current?.close();
      controllers.current.forEach((c) => c.abort());
    },
    [speaker],
  );

  useEffect(() => setSfxEnabled(settings.uiSounds), [settings.uiSounds]);

  /** Voice settings the acknowledgements were last synthesized for. */
  const warmedRef = useRef('');
  /**
   * Points the speaker at Iris's voice: the natural voice of the provider that has one (OpenAI or
   * Gemini, see lib/providers.ts), or the free local voice (chosen, or when no provider speaks).
   */
  const configureSpeaker = useCallback(() => {
    const { settings: s, secrets: k } = live.current;
    const media = s.ttsEngine === 'natural' ? mediaProvider(s, k) : null;
    const config: SpeakerConfig = media
      ? { engine: media, apiKey: k[media], voice: media === 'google' ? s.geminiVoice : s.voice, language: s.language }
      : { engine: 'local', voice: 'local', language: s.language };
    speaker.configure(config);
    // The acknowledgements are synthesized ahead (a few seconds later: the local voice works one
    // sentence at a time, and the greeting or the reply comes first).
    const warm = `${config.engine}|${config.voice}|${s.language}|${s.honorific}`;
    if (warmedRef.current !== warm) {
      warmedRef.current = warm;
      window.setTimeout(() => speaker.prewarm(allAcknowledgements(speechLang(s.language), s.honorific)), 5_000);
    }
  }, [speaker]);


  /** Says one line on its own speech channel (resolves once spoken). */
  const say = useCallback(
    (text: string, channel: string) => {
      configureSpeaker();
      speaker.enqueue(text, channel);
      return speaker.end(channel);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [speaker, configureSpeaker],
  );

  /**
   * Esc / "cut Iris off": stops her voice only. Running tasks continue silently (their text
   * still appears), and the microphone / voice session are untouched.
   */
  const stopSpeaking = useCallback(() => {
    sessionRef.current?.interrupt();
    const running = live.current.tasks.filter((t) => t.status === 'running').map((t) => t.id);
    speaker.mute([...running, 'greeting', 'approval']);
  }, [speaker]);

  // ------------------------------------------------------------------ tasks

  const chain = useMemo(() => brainChain(settings, secrets), [settings, secrets]);
  // A settings/key change may change which model answers next.
  useEffect(() => setActiveBrain(null), [chain]);

  const patchMessage = useCallback((id: string, fn: (m: ChatMessage) => ChatMessage) => {
    setMessages((prev) => prev.map((m) => (m.id === id ? fn(m) : m)));
  }, []);
  const patchTask = useCallback((id: string, patch: Partial<Task>) => {
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }, []);
  const addTask = useCallback((task: Omit<Task, 'status' | 'activity' | 'startedAt'>) => {
    setTasks((prev) => [...prev, { ...task, status: 'running', activity: null, startedAt: Date.now() }]);
  }, []);
  const finishTask = useCallback(
    (id: string, status: Task['status']) => {
      controllers.current.delete(id);
      patchTask(id, { status, activity: null, endedAt: Date.now() });
    },
    [patchTask],
  );

  // Finished tasks fade out of the tray after a few seconds.
  useEffect(() => {
    const finished = tasks.filter((t) => t.status !== 'running' && t.endedAt);
    if (finished.length === 0) return;
    const next = Math.min(...finished.map((t) => t.endedAt! + FINISHED_TASK_TTL_MS)) - Date.now();
    const timer = window.setTimeout(
      () => setTasks((prev) => prev.filter((t) => t.status === 'running' || !t.endedAt || t.endedAt + FINISHED_TASK_TTL_MS > Date.now())),
      Math.max(0, next),
    );
    return () => window.clearTimeout(timer);
  }, [tasks]);

  /** Adds a finished assistant line to the conversation (local answers, timer alerts). */
  const addLocalReply = useCallback((content: string, brain = 'Local · 0 token') => {
    setMessages((prev) => [...prev, { id: uid(), role: 'assistant', content, brain }]);
  }, []);

  // ------------------------------------------------------------------ the other hooks

  const approvals = useApprovals({ say, silence: (channel) => speaker.cancel(channel), honorific, replyLang });
  // Scheduled requests run through `send` (defined further down).
  const runRequestRef = useRef<(text: string) => void>(() => {});
  const lastRequestAtRef = useRef(0);
  /** The user is in the middle of something with Iris (a request, her voice, an approval, just spoke). */
  const isBusy = () =>
    ttsBusyRef.current ||
    approvals.pendingCount > 0 ||
    Date.now() - lastRequestAtRef.current < 60_000 ||
    live.current.tasks.some((t) => t.status === 'running' && !isBackgroundTask(t.id));
  const { startTimer, trackAlert, trackScheduled } = useBackgroundJobs({
    live,
    controllers,
    addTask,
    patchTask,
    finishTask,
    addLocalReply,
    say,
    replyLang,
    honorific,
    setNotice,
    runRequest: runRequestRef,
    isBusy,
    askToInterrupt: (taskId, label) => {
      const lang = replyLang();
      const fr = lang === 'fr';
      const hon = honorific(lang);
      const question = fr
        ? `${hon ? `${hon}, puis-je` : 'Puis-je'} vous interrompre ? C'est l'heure de : ${label}.`
        : `${hon ? `${hon}, may I` : 'May I'} interrupt? It's time for: ${label}.`;
      return approvals.requestApproval(
        taskId,
        { id: uid(), title: fr ? `Tâche programmée : ${label}` : `Scheduled task: ${label}`, details: [{ label: fr ? 'Pourquoi je demande' : 'Why I ask', value: fr ? 'Vous sembliez occupé.' : 'You seemed busy.' }], risk: 'low' },
        true,
        question,
      );
    },
  });

  /**
   * One-shot generation with the chat brain, without tools and with its own instructions:
   * screen descriptions, conversation summaries. Its usage is counted like any request.
   */
  const generate = useCallback(async (
    system: string,
    content: Extract<ModelMessage, { role: 'user' }>['content'],
    signal?: AbortSignal,
    role: BrainRole = 'chat',
  ) => {
    const { settings, secrets } = live.current;
    let text = '';
    await streamReply({
      chain: brainChain(settings, secrets, role),
      messages: [{ role: 'user', content }],
      tools: {},
      signal: signal ?? new AbortController().signal,
      onBrain: () => {},
      onDelta: (delta) => {
        text += delta;
      },
      system,
      firstChunkTimeoutMs: 20_000,
    });
    return text.trim();
  }, []);

  // Timers, alerts and scheduled tasks wait in the background: they don't make the conversation busy.
  const busy = tasks.some((t) => t.status === 'running' && !isBackgroundTask(t.id));
  const memory = useConversationMemory({ live, messages, setMessages, generate, busy });

  // Search by meaning (lib/semantic.ts): the local index follows its setting.
  useEffect(() => semanticMemory.configure(settings.semanticMemory), [settings.semanticMemory]);
  // The same memory on every device (lib/sync.ts), when a sync storage is configured.
  useEffect(() => syncService.start(() => parseSyncConfig(live.current.secrets.sync)), []);
  useEffect(() => {
    if (secrets.sync) void syncService.run(parseSyncConfig(secrets.sync));
  }, [secrets.sync]);

  // Iris speaks up by herself when something deserves it (proactive.ts).
  useProactivity({
    live,
    // (Not during a premium voice session either: its own voice would overlap.)
    isBusy: () => isBusy() || !!sessionRef.current,
    say,
    addReply: addLocalReply,
    generate: (system, content) => generate(system, content),
    honorific,
    replyLang: () => replyLang(),
    // Her offer's answer ("oui") gets the tools it needs, like a follow-up.
    offerGroups: (groups) => groups.forEach((g) => recentGroupsRef.current.set(g, GROUP_MEMORY)),
  });

  // ------------------------------------------------------------------ tools

  /**
   * The tools wired to the HUD for one task. `spoken`: approvals are also asked aloud (and can
   * be answered by voice). `taintedFromStart`: the conversation holds documents (outside content).
   */
  const buildTools = useCallback(
    (
      taskId: () => string,
      isCurrent: () => boolean,
      attach: (b: Briefing) => void,
      signal?: AbortSignal,
      { spoken = false, taintedFromStart = false }: { spoken?: boolean; taintedFromStart?: boolean } = {},
    ): ToolSet => {
      const { settings: s, secrets: k } = live.current;
      const hooks: ToolHooks = {
        onActivity: (label) => {
          if (isCurrent()) patchTask(taskId(), { activity: label });
        },
        onBriefing: (b) => {
          if (!isCurrent()) return;
          showCard(b);
          attach(b);
          // What was looked up joins the knowledge graph (no tokens).
          if (live.current.settings.autoMemory) knowledgeStore.fromBriefing(b);
        },
      };
      const visualHooks = {
        ...hooks,
        lastVisual: () => visualRef.current,
        // Visuals are written by the text brain (also during voice conversations: it codes far
        // better than the realtime voice model), with the recent conversation as context.
        generate: async (system: string, prompt: string, onText: (text: string) => void) => {
          const { settings, secrets, messages } = live.current;
          const context = messages
            .filter((m) => m.content && !m.error)
            .slice(-8)
            .map((m) => `${m.role === 'user' ? 'User' : 'Iris'}: ${m.content.slice(0, 2000)}`)
            .join('\n');
          let text = '';
          await streamReply({
            // Visuals get the stronger "builder" model when one is set (Settings).
            chain: brainChain(settings, secrets, 'builder'),
            messages: [{ role: 'user', content: context ? `${prompt}\n\n---\nRecent conversation, for context only:\n${context}` : prompt }],
            tools: {},
            signal: signal ?? new AbortController().signal,
            onBrain: () => {},
            onDelta: (delta) => {
              text += delta;
              if (isCurrent()) onText(text);
            },
            system,
            firstChunkTimeoutMs: 30_000,
          });
          return text;
        },
      };
      const osHooks = {
        ...hooks,
        autonomous: s.autonomous,
        requestApproval: (request: ActionRequest) =>
          isCurrent() ? approvals.requestApproval(taskId(), request, spoken) : Promise.resolve(false),
      };
      const fr = speechLang(s.language) === 'fr';
      const builtin: ToolSet = {
        // Tools answer in the language the user is speaking (the model may omit `language`).
        ...createTools(hooks, userLangRef.current ?? s.language, { tavilyKey: k.tavily }),
        ...createOsTools(osHooks, s.language),
        ...createMediaTools(hooks, { provider: mediaProvider(s, k), apiKey: k[mediaProvider(s, k) ?? 'openai'], imageModel: s.imageModel, fr }),
        ...createVisualTools(visualHooks, userLangRef.current ?? s.language),
        // Ready-made widgets (map, chart, table…): data shown for a few tokens, no generated UI.
        ...createWidgetTools(visualHooks, userLangRef.current ?? s.language),
        ...createPanelTools(panelHooks),
        ...createTimerTools((seconds, label) => startTimer(seconds, label, 'voice')),
        ...createAlertTools({ onAdded: trackAlert, onRemoved: (id) => finishTask(`alert-${id}`, 'cancelled') }, userLangRef.current ?? s.language),
        ...createScheduleTools({ onAdded: trackScheduled, onRemoved: (id) => finishTask(`sched-${id}`, 'cancelled') }, (userLangRef.current ?? s.language) === 'fr'),
        ...createMemoryTools(),
        // The user's calendar and inbox, read only, when connected (Settings → Proactivity).
        ...createPersonalTools({ calendars: parseCalendarUrls(k.calendar), mail: parseMailAccount(k.mail) }, hooks.onActivity),
        // Mouse and keyboard: each step is decided by the "builder" model (stronger at locating
        // things on a screenshot when one is set).
        ...createComputerTools({
          ...osHooks,
          fr,
          signal,
          decide: (system, content, stepSignal) => generate(system, content, stepSignal, 'builder'),
        }),
        ...createScreenTools({
          ...hooks,
          fr,
          describe: (question, jpeg) =>
            generate(SCREEN_SYSTEM, [{ type: 'text', text: question }, { type: 'image', image: jpeg, mediaType: 'image/jpeg' }], signal),
        }),
      };
      // Phones and tablets don't let an app drive other apps, the screen or the volume.
      if (IS_MOBILE) for (const name of DESKTOP_ONLY_TOOLS) delete builtin[name];
      // Skills Iris created for itself (installed with the user's approval) + create/run_skill.
      const skills = createSkillTools(osHooks, fr, new Set(Object.keys(builtin)));
      // External services (MCP): what changes data asks first, like the computer actions.
      const services = mcpTools();
      const external: ToolSet = Object.fromEntries(
        services.map((t) => [
          t.name,
          {
            ...t.tool,
            description: `[${t.server}] ${t.tool.description ?? ''}`,
            execute: async (args: unknown, options: unknown) => {
              if (!t.readOnly && !osHooks.autonomous) {
                const allowed = await osHooks.requestApproval({
                  id: uid(),
                  title: `${t.server} · ${t.name.slice(`mcp_${t.server}_`.length) || t.name}`,
                  details: [{ label: fr ? 'Paramètres' : 'Arguments', value: JSON.stringify(args, null, 2), mono: true }],
                  risk: t.destructive ? 'high' : 'medium',
                });
                if (!allowed) return { done: false, note: 'The user declined this action. Acknowledge briefly; do not retry.' };
              }
              hooks.onActivity(`${t.server}…`);
              try {
                return clipMcpResult(await t.tool.execute!(args as never, options as never));
              } finally {
                hooks.onActivity(null);
              }
            },
          } as Tool,
        ]),
      );
      // Once the task has read outside content (a page, a document, the screen, a service), its
      // risky actions ask first, even in autonomous mode (see untrusted.ts).
      const writes = new Set(services.filter((t) => !t.readOnly).map((t) => t.name));
      const guarded = guardUntrusted(
        { ...builtin, ...skills, ...external },
        {
          autonomous: () => live.current.settings.autonomous,
          taintedFromStart,
          alsoRisky: (name) => writes.has(name),
          ask: (name, args) =>
            osHooks.requestApproval({
              id: uid(),
              title: `${toolLabel(name, fr ? 'fr' : 'en')}${fr ? ', après la lecture d’un contenu extérieur' : ', after reading outside content'}`,
              details: [
                {
                  label: fr ? 'Pourquoi je demande' : 'Why I ask',
                  value: fr
                    ? 'Cette tâche a lu une page web, un document, l’écran ou un service extérieur. Par sécurité, je vérifie avec vous avant d’agir.'
                    : 'This task read a web page, a document, the screen or an outside service. For safety, I check with you before acting.',
                },
                { label: fr ? 'Paramètres' : 'Arguments', value: JSON.stringify(args, null, 2), mono: true },
              ],
              risk: 'high',
            }),
        },
      );
      // Each kind of tool has its own interface sound when it starts (like a sci-fi HUD).
      return withToolSounds(guarded.tools);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [patchTask, showCard, panelHooks, startTimer, trackAlert, trackScheduled, generate],
  );

  /** Stops one task: its generation, its voice and its pending approvals. */
  const cancelTask = useCallback(
    (id: string) => {
      const task = live.current.tasks.find((t) => t.id === id);
      if (!task || task.status !== 'running') return;
      controllers.current.get(id)?.abort();
      speaker.cancel(id);
      approvals.declineApprovals(id);
      finishTask(id, 'cancelled');
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [speaker, finishTask],
  );

  // ------------------------------------------------------------------ voice (OpenAI Realtime)

  const stopVoice = useCallback(() => {
    const session = sessionRef.current;
    sessionRef.current = null;
    session?.close();
  }, []);

  /**
   * Opens the voice conversation. `wake`: the sentence that woke Iris on hands-free standby
   * (audio + local transcript), answered as soon as the session is up.
   */
  const startVoice = useCallback(async (wakeUp?: { audio: Float32Array; text: string }) => {
    const { settings: s, secrets: k } = live.current;
    if (!k.openai) {
      setNotice('Voice conversations use OpenAI Realtime: add your OpenAI API key in Settings.');
      live.current.onNeedSettings();
      return;
    }
    speaker.stop();
    setNotice(null);

    const label = `OpenAI Realtime · ${s.realtimeModel}`;
    let irisSpeaking = false;
    /** "Stop listening": the mic is cut at once, the session ends after the acknowledgement. */
    let sleepRequested = false;
    let sleepTimer = 0;
    const sleep = () => {
      sleepRequested = true;
      session.setMicEnabled(false);
      // In case the acknowledgement is never spoken.
      sleepTimer = window.setTimeout(() => {
        if (sessionRef.current === session) stopVoice();
      }, 10_000);
    };
    /** Assistant message for a Realtime response (created on first use). */
    const ensureVoiceReply = (responseId: string, fn?: (m: ChatMessage) => ChatMessage): string => {
      const id = `rt-a-${responseId}`;
      setMessages((prev) => {
        const exists = prev.some((m) => m.id === id);
        const base = exists ? prev : [...prev, { id, role: 'assistant' as const, content: '', brain: label }];
        return fn ? base.map((m) => (m.id === id ? fn(m) : m)) : base;
      });
      return id;
    };

    const session: RealtimeSession = new RealtimeSession({
      // Only sentences addressed to Iris are answered (wake word), so nothing is shown until
      // the words are known; someone talking in the room doesn't cut Iris off.
      onUserSpeechStart: () => {
        if (sessionRef.current === session && !irisSpeaking) setVoicePhase('listening');
      },
      onUserTranscript: (itemId, text) => {
        const id = `rt-u-${itemId}`;
        if (text) session.setUserLanguage(noteUserLanguage(text));
        if (sessionRef.current === session) setVoicePhase('thinking');
        setMessages((prev) => {
          if (!text) return prev.filter((m) => m.id !== id); // noise, nothing said
          return prev.some((m) => m.id === id)
            ? prev.map((m) => (m.id === id ? { ...m, content: text } : m))
            : [...prev, { id, role: 'user', content: text }];
        });
      },
      onAssistantDelta: (responseId, delta) => ensureVoiceReply(responseId, (m) => ({ ...m, content: m.content + delta })),
      onAssistantDone: (responseId, text) => {
        if (text) ensureVoiceReply(responseId, (m) => ({ ...m, content: text }));
      },
      onIgnoredSpeech: (_itemId, text) => {
        // console.warn: forwarded to the dev log, like the other voice diagnostics.
        console.warn(`[iris:realtime] ignored (not addressed to Iris): "${text}"`);
      },
      onSpeaking: (value) => {
        irisSpeaking = value;
        if (sessionRef.current !== session) return;
        if (!value && sleepRequested) {
          stopVoice();
          playSfx('stop');
          return;
        }
        setVoicePhase(value ? 'speaking' : 'listening');
      },
      // Each tool call is a task: several can run at once while the conversation goes on.
      runTool: async (name, args, callId): Promise<unknown> => {
        // Cancelling the task (✕ in the tray) aborts long tools such as building a visual.
        const controller = new AbortController();
        const tool = voiceTools(callId, controller.signal)[name];
        if (!tool?.execute) return { error: `Unknown tool ${name}` };
        const taskId = `rt-t-${callId}`;
        controllers.current.set(taskId, controller);
        addTask({ id: taskId, title: toolTaskTitle(name, args), source: 'voice' });
        try {
          const result: unknown = await tool.execute(args as never, { toolCallId: callId, messages: [] } as never);
          finishTask(taskId, 'done');
          return result;
        } catch (error) {
          finishTask(taskId, controller.signal.aborted ? 'cancelled' : 'error');
          throw error;
        } finally {
          controllers.current.delete(taskId);
        }
      },
      onLevel: setLevel,
      onError: (error) => setNotice(`Voice: ${error.message}`),
      onClosed: () => {
        window.clearTimeout(sleepTimer);
        if (sessionRef.current && sessionRef.current !== session) return;
        sessionRef.current = null;
        setVoiceActive(false);
        approvals.declineApprovals();
        levelRef.current = 0;
      },
    });

    /** Tools bound to one voice tool call (its task id, its reply for briefings). */
    const voiceTools = (callId: string, signal?: AbortSignal): ToolSet => ({
      ...buildTools(
        () => `rt-t-${callId}`,
        () => sessionRef.current === session && live.current.tasks.find((t) => t.id === `rt-t-${callId}`)?.status !== 'cancelled',
        (b) =>
          setMessages((prev) => {
            // Attach to the voice reply that already holds it (live updates), else the latest one.
            const holder = prev.find((m) => m.briefings?.some((x) => x.id === b.id));
            const last = holder ?? [...prev].reverse().find((m) => m.role === 'assistant' && m.id.startsWith('rt-a-'));
            return last ? prev.map((m) => (m === last ? { ...m, briefings: upsertBriefing(m.briefings, b) } : m)) : prev;
          }),
        signal,
        { taintedFromStart: attachmentsRef.current.size > 0 },
      ),
      ...createSessionTools({ sleep }),
    });

    sessionRef.current = session;
    setVoiceActive(true);
    setVoicePhase('listening');
    setActiveBrain(label);
    playSfx('listen');

    const osContext = await loadOsContext()
      .then(describeOsContext)
      .catch(() => undefined);
    const vocabulary = parseVocabulary(s.vocabulary);
    const toolNames = Object.keys(voiceTools('probe'));
    const instructions = [
      // The current language is added (and kept up to date) by the session itself.
      systemPrompt(toolNames, { osContext, honorific: s.honorific, language: { preferred: s.language }, autonomous: s.autonomous, ...memory.memoryContext() }),
      VOICE_NOTE,
      turnContext(),
      'This is a live spoken conversation: answer in short, natural spoken sentences, and stop as soon as the user interrupts you.',
      'You can run several tools at once when the user asks for several things.',
      'The user addresses you by saying your name at the start or the end of a request ("Iris, …" / "…, Iris"): that is not part of the request, do not comment on it.',
      vocabulary.length ? `Names the user often mentions (use this spelling): ${vocabulary.join(', ')}.` : '',
    ]
      .filter(Boolean)
      .join('\n');

    try {
      await session.start({
        apiKey: k.openai,
        model: s.realtimeModel,
        voice: s.voice,
        instructions,
        tools: voiceTools('schema'),
        language: s.language === 'multi' ? undefined : s.language,
        userLanguage: userLangRef.current,
        // The name must be transcribed reliably for the wake word to be recognised.
        transcriptionPrompt: ['Iris', ...vocabulary].join(', '),
        wakeWord: true,
        prelude: wakeUp,
        history: live.current.messages
          .filter((m) => m.content && !m.error)
          .map((m) => ({ role: m.role, content: m.content })),
      });
    } catch (error) {
      if (sessionRef.current !== session) return;
      session.close();
      // Not describeError(): its patterns are for text models. Realtime errors are already explicit.
      const message =
        error instanceof DOMException && error.name !== 'TimeoutError'
          ? micErrorMessage(error)
          : error instanceof DOMException
            ? 'OpenAI did not answer in time. Check your internet connection.'
            : error instanceof Error
              ? error.message
              : String(error);
      setNotice(`Voice: ${message}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speaker, buildTools, addTask, finishTask, stopVoice]);

  // ------------------------------------------------------------------ local answers (0 token)

  /** "Stop listening": back to standby (no follow-up window, the premium session closes). */
  const standBy = useCallback(() => {
    standbyRequestedRef.current = true;
    followUpUntilRef.current = 0;
    if (sessionRef.current) stopVoice();
  }, [stopVoice]);

  const runLocalCommand = useLocalCommands({ live, replyLang, honorific, setMessages, addLocalReply, say, startTimer, stopSpeaking, standBy });

  // ------------------------------------------------------------------ requests (typed or spoken)

  /**
   * One request: typed, or spoken (`voice`: transcribed locally in economy voice mode — answered
   * aloud, and the model is told names may be mis-heard).
   */
  const send = useCallback(
    async (raw: string, attachments: Attachment[] = [], { voice = false, heardAt }: { voice?: boolean; heardAt?: number } = {}) => {
      const fr = navigator.language.startsWith('fr');
      const text =
        raw.trim() ||
        (attachments.length ? (fr ? 'Analyse ce document et résume-le.' : 'Analyse this document and summarise it.') : '');
      if (!text) return;
      const source: Task['source'] = voice ? 'voice' : 'text';
      if (!text.startsWith('🗓')) {
        lastRequestAtRef.current = Date.now();
        markActivity();
      }

      // Everyday requests (time, timer, volume, open an app…) never reach the AI.
      if (attachments.length === 0) {
        const command = matchLocalCommand(text);
        if (command && (await runLocalCommand(command, text, source))) return;
      }

      // During a voice session, typed text goes to the same live conversation. Documents are
      // always analysed by the text brain (the voice model can't read PDFs).
      const lang = noteUserLanguage(text);
      if (sessionRef.current && attachments.length === 0) {
        sessionRef.current.setUserLanguage(lang);
        setMessages((prev) => [...prev, { id: uid(), role: 'user', content: text }]);
        sessionRef.current.sendText(text);
        return;
      }

      setNotice(null);
      const { settings: s, secrets: k, messages: past, tasks: running } = live.current;
      const taskId = uid();
      const user: ChatMessage = {
        id: uid(),
        role: 'user',
        content: text,
        attachments: attachments.length ? attachments.map((a) => ({ name: a.name, kind: a.kind, size: a.size })) : undefined,
      };
      const reply: ChatMessage = { id: uid(), role: 'assistant', content: '' };
      if (attachments.length) attachmentsRef.current.set(user.id, attachments);

      // Context: the conversation so far, minus the exchanges other tasks are still working on
      // (a half-written reply would confuse the model). Documents are sent again for the next
      // few questions ("and on page 3?"); after that only their names, with reread_document.
      // Messages covered by the conversation summary are not sent (the summary is in the
      // instructions instead).
      const inFlight = new Set(running.filter((t) => t.status === 'running').flatMap((t) => t.messageIds ?? []));
      const visible = past.filter((m) => !m.error && m.content && !inFlight.has(m.id));
      const coveredId = memory.summaryRef.current?.coveredId;
      const recent = [...visible.slice(visible.findIndex((m) => m.id === coveredId) + 1), user].slice(-HISTORY_LIMIT);
      const withDocs = new Set(recent.filter((m) => m.role === 'user').slice(-(DOCUMENT_FOLLOW_UPS + 1)).map((m) => m.id));
      const earlierDocs: Attachment[] = [];
      const history = recent.map((m) => {
        if (m.role === 'assistant') return { role: 'assistant', content: m.content } as ModelMessage;
        const docs = attachmentsRef.current.get(m.id) ?? [];
        if (docs.length === 0 || withDocs.has(m.id)) return { role: 'user', content: userContent(m.content, docs) } as ModelMessage;
        earlierDocs.push(...docs);
        return { role: 'user', content: documentNote(m.content, docs) } as ModelMessage;
      });
      // Documents of summarized messages can still be re-read.
      const recentIds = new Set(recent.map((m) => m.id));
      attachmentsRef.current.forEach((docs, id) => {
        if (!recentIds.has(id)) earlierDocs.push(...docs);
      });
      const documents = earlierDocs.length ? createDocumentTools(earlierDocs) : null;

      setMessages((prev) => [...prev, user, reply]);
      addTask({
        id: taskId,
        title: text.length > 60 ? `${text.slice(0, 59)}…` : text,
        source,
        messageIds: [user.id, reply.id],
      });

      const controller = new AbortController();
      controllers.current.set(taskId, controller);
      const isCurrent = () => !controller.signal.aborted;
      // A spoken request is always answered aloud.
      const speak = (voice || s.speakReplies);
      // Its latency is measured until the first sound (telemetry).
      if (voice && heardAt) heardAtRef.current.set(taskId, heardAt);
      configureSpeaker();
      let pending = '';
      /** Some of the reply itself (not an acknowledgement) is queued for speech. */
      let replyStarted = false;

      const tools: ToolSet = {
        ...buildTools(
          () => taskId,
          isCurrent,
          (b) => patchMessage(reply.id, (m) => ({ ...m, briefings: upsertBriefing(m.briefings, b) })),
          controller.signal,
          // Documents in the conversation are outside content: risky actions will ask first.
          { spoken: speak, taintedFromStart: attachmentsRef.current.size > 0 },
        ),
        ...documents?.tools,
        // "Stop listening" in other words than the local command understands.
        ...(voice &&
          createSessionTools({
            sleep: () => {
              standbyRequestedRef.current = true;
              followUpUntilRef.current = 0;
            },
          })),
      };

      // Spoken requests: if nothing is said quickly, a short local acknowledgement ("Je regarde
      // ça.") fills the wait — pre-synthesized, no tokens. At most one per request.
      let spoke = false;
      const acknowledge = (toolName: string | null) => {
        if (spoke || !isCurrent()) return;
        spoke = true;
        speaker.enqueueCached(acknowledgement(toolName, lang === 'fr' || lang === 'en' ? lang : speechLang(s.language), s.honorific), taskId);
      };
      const ackTimer = voice && speak ? window.setTimeout(() => acknowledge(null), ACK_AFTER_MS) : undefined;
      const calledGroups = new Set<ToolGroup>();

      try {
        // Memories close in meaning to the request, beyond the recent facts already in the
        // instructions (lib/semantic.ts) — looked up while the OS context loads.
        const [osContext, recalled] = await Promise.all([
          loadOsContext()
            .then(describeOsContext)
            .catch(() => undefined),
          semanticMemory.relevantFor(text, new Set(memoryStore.facts().slice(-40).map((f) => f.text))),
        ]);
        if (recalled) console.warn(`[iris:semantic] recalled for this request:\n${recalled}`);
        // Only the tool groups this request needs are sent (see toolGroups.ts).
        const selection = selectTools(tools, text, recentGroupsRef.current.keys(), (names) => toolGuidance(names, s.autonomous, osContext));
        console.warn(`[iris:tools] ${selection.active().length}/${Object.keys(tools).length} tools · groups: ${[...selection.groups].join(', ') || 'core'}`);
        await streamReply({
          chain: brainChain(s, k),
          messages: history,
          tools: { ...tools, ...selection.loadTools },
          activeTools: selection.active,
          savedToolTokensPerStep: Math.max(0, definitionTokens(tools, Object.keys(tools)) - definitionTokens(tools, selection.active())),
          osContext,
          signal: controller.signal,
          onBrain: (brain) => {
            setActiveBrain(brain.label);
            patchMessage(reply.id, (m) => ({ ...m, brain: brain.label }));
          },
          onDelta: (delta) => {
            if (!isCurrent()) return;
            patchMessage(reply.id, (m) => ({ ...m, content: m.content + delta }));
            if (!speak) return;
            pending += delta;
            // Until the reply's first words are queued, its first clause is enough to start.
            const [sentences, rest] = splitSentences(pending, { firstClause: !replyStarted });
            pending = rest;
            if (sentences.length) spoke = replyStarted = true;
            sentences.forEach((sentence) => speaker.enqueue(sentence, taskId));
          },
          onToolCall: (name) => {
            const group = groupOf(name);
            if (group !== 'core') calledGroups.add(group);
            // A slow tool (web, screen, a build…): acknowledge at once instead of waiting.
            if (voice && speak && SLOW_TOOLS.test(name)) acknowledge(name);
          },
          onFallback: (failed, error) => {
            if (isCurrent()) setNotice(`${failed.label} — ${describeError(error)}`);
          },
          honorific: s.honorific,
          language: { preferred: s.language, current: lang },
          autonomous: s.autonomous,
          prepareStep: documents?.inject,
          fromVoice: voice,
          memory: { ...memory.memoryContext(), recalled },
        });
        window.clearTimeout(ackTimer);
        // Groups used now stay available for the next two exchanges (follow-ups).
        rememberGroups(calledGroups);
        if (!isCurrent()) return;
        if (speak && pending.trim()) speaker.enqueue(pending, taskId);
        finishTask(taskId, 'done');
        await speaker.end(taskId);
        heardAtRef.current.delete(taskId);
        // Silent reply (no voice available): the follow-up window opens now instead.
        if (voice && !speak && !standbyRequestedRef.current) {
          followUpFromRef.current = Date.now();
          followUpUntilRef.current = Date.now() + FOLLOW_UP_MS;
        }
      } catch (error) {
        window.clearTimeout(ackTimer);
        rememberGroups(calledGroups);
        heardAtRef.current.delete(taskId);
        if (!isCurrent()) return;
        speaker.cancel(taskId);
        patchMessage(reply.id, (m) => (m.content ? m : { ...m, content: describeError(error), error: true }));
        finishTask(taskId, 'error');
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [speaker, configureSpeaker, buildTools, patchMessage, addTask, finishTask, runLocalCommand, rememberGroups],
  );

  /** Speaks the startup status line (once the HUD's boot sequence is over). */
  const greet = useCallback(async () => {
    const { settings: s } = live.current;
    if (!s.speakReplies) return;
    configureSpeaker();
    speaker.enqueue(greetingText(speechLang(s.language), s.honorific, new Date()), 'greeting');
    await speaker.end('greeting');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speaker, configureSpeaker]);

  // ------------------------------------------------------------------ always-on listening (local)

  /**
   * Iris listens from launch. Economy voice needs a brain (any key); premium voice needs
   * OpenAI Realtime.
   */
  const listening = settings.voiceMode === 'realtime' ? hasRealtime(secrets) : chain.length > 0;
  runRequestRef.current = (text) => void send(text, [], { voice: true });
  const approvalPending = () => approvals.pendingCount > 0;
  const voiceInput = useRef<VoiceInput>({ send, startVoice, runLocalCommand, answerApproval: approvals.answerByVoice, approvalPending, stopSpeaking });
  voiceInput.current = { send, startVoice, runLocalCommand, answerApproval: approvals.answerByVoice, approvalPending, stopSpeaking };
  const { wakeStatus } = useLocalVoice({
    listening,
    voiceActive,
    live,
    speaker,
    sessionRef,
    ttsBusyRef,
    followUpFromRef,
    followUpUntilRef,
    input: voiceInput,
    setLevel,
  });

  // External services: (re)connected when their configuration changes.
  useEffect(() => {
    void configureMcp(secrets.mcp);
  }, [secrets.mcp]);

  /** "Cancel all" (task tray): stops the voice, every running task and pending approval. */
  const cancel = useCallback(() => {
    stopSpeaking();
    for (const t of live.current.tasks) if (t.status === 'running') cancelTask(t.id);
    approvals.declineApprovals();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stopSpeaking, cancelTask]);

  /** New conversation. The finished one is archived (journal + archive), not lost. */
  const clear = useCallback(() => {
    cancel();
    memory.archiveConversation();
    setMessages([]);
    setTasks([]);
    setNotice(null);
    setBriefing(null);
    setVisual(null);
    visualRef.current = null;
    attachmentsRef.current.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cancel]);

  const runningTasks = tasks.filter((t) => t.status === 'running');

  // Nobody has spoken to Iris for a while → close the cloud session and go back to local
  // standby (no more tokens). Silent for the user: Iris keeps listening for her name. Speech
  // not addressed to her keeps the phase at "listening", so it doesn't postpone this.
  const standbyDue =
    voiceActive && voicePhase === 'listening' && approvals.pendingCount === 0 && !runningTasks.some((t) => t.source === 'voice');
  useEffect(() => {
    if (!standbyDue) return;
    const timer = window.setTimeout(() => {
      if (sessionRef.current) stopVoice();
    }, HANDS_FREE_IDLE_MS);
    return () => window.clearTimeout(timer);
  }, [standbyDue, stopVoice]);

  // On local standby Iris is listening too (for her name).
  const phase: Phase = voiceActive
    ? voicePhase
    : speaking
      ? 'speaking'
      : runningTasks.length > 0
        ? 'thinking'
        : wakeStatus.status === 'listening'
          ? 'listening'
          : 'idle';
  const latestActivity = [...runningTasks].reverse().find((t) => t.activity)?.activity ?? null;

  return {
    phase,
    messages,
    tasks,
    cancelTask,
    notice,
    dismissNotice: () => setNotice(null),
    levelRef,
    brainLabel: activeBrain ?? chain[0]?.label ?? null,
    hasBrain: chain.length > 0,
    voiceActive,
    /** Iris can listen (economy voice: any AI key; premium: an OpenAI key). */
    voiceReady: listening,
    voiceMode: settings.voiceMode,
    /** Local "Iris" detection (always-on listening). */
    wakeStatus,
    send,
    stopSpeaking,
    /** Iris is talking (voice session or spoken typed reply). */
    speaking: voiceActive ? voicePhase === 'speaking' : speaking,
    cancel,
    clear,
    briefing,
    showBriefing,
    closeBriefing: () => setBriefing(null),
    visual,
    closeVisual,
    activity: latestActivity,
    pendingAction: approvals.pendingAction,
    pendingCount: approvals.pendingCount,
    respondToAction: approvals.respondToAction,
    greet,
  };
}
