import { useCallback, useState } from 'react';
import { FALLBACK_CHAT_MODELS } from './modelDefaults';
import type { Price } from './costs';
import { DEFAULT_UI_LANGUAGE, isUiLanguage, type UiLanguage } from '../i18n';

/** Non-secret preferences (API keys live in the Stronghold vault, see secrets.ts). */
export type CloudProvider = 'anthropic' | 'openai' | 'google';
/** Language of the conversation; `multi` = let the models detect it. */
export type Language = 'en' | 'fr' | 'multi';
export type VoiceMode = 'economy' | 'realtime';
/** `natural`: the voice of the connected provider (OpenAI or Gemini); `local`: a free voice computed on this computer. */
export type TtsEngine = 'natural' | 'local';

export interface Settings {
  /** Bumped when defaults change in a way that should apply to existing users. */
  version: number;
  /** Brain for typed conversations; the others are fallbacks when it fails. */
  cloudProvider: CloudProvider;
  cloudModels: Record<CloudProvider, string>;
  /**
   * Model that writes visuals (web pages, documents, code), per provider; empty = the chat model.
   * Lets the conversation run on an inexpensive model while visuals get a stronger one.
   */
  builderModels: Record<CloudProvider, string>;
  /**
   * Per provider: both models are picked from what the key can use (see modelDefaults.ts).
   * Choosing a model by hand in Settings turns it off for that provider.
   */
  modelsAuto: Record<CloudProvider, boolean>;
  /**
   * `economy`: speech is transcribed on this computer and answered by the text brain, read aloud
   * by text-to-speech (text tokens only). `realtime`: OpenAI Realtime speech-to-speech (more
   * natural, much more expensive audio tokens).
   */
  voiceMode: VoiceMode;
  /**
   * Iris's voice: the natural voice of the provider that has one (OpenAI or Gemini, see
   * lib/providers.ts), or a Piper voice computed on this computer (free, offline).
   */
  ttsEngine: TtsEngine;
  /** Iris notes lasting facts about the user by herself (they can always be asked to remember). */
  autoMemory: boolean;
  /**
   * At launch, continue the last conversation where it was left. Off (default): each session starts
   * empty — the previous conversation is archived (recall_memory still finds it when asked).
   */
  resumeConversation: boolean;
  /** Start Iris at login (Windows, macOS, Linux), straight in the tray (off by default). */
  launchAtStartup: boolean;
  /**
   * Talking while Iris speaks cuts her off, without saying her name: she pauses at once and
   * listens (her own voice's echo and noises are told apart). Off: only « Iris, … » stops her.
   */
  bargeIn: boolean;
  /** OpenAI Realtime speech-to-speech model used for voice conversations. */
  realtimeModel: string;
  /** OpenAI voice, shared by Realtime and by spoken typed replies. */
  voice: string;
  /** Gemini voice, when the natural voice comes from Gemini. */
  geminiVoice: string;
  language: Language;
  /** Read typed replies aloud (same voice). */
  speakReplies: boolean;
  /** How Iris addresses the user ("Monsieur", "Madame", a first name…); empty = no honorific. */
  honorific: string;
  /** Spoken status greeting when the HUD comes online. */
  bootGreeting: boolean;
  /** Interface chirps (listening, approvals…). */
  uiSounds: boolean;
  /** Names, brands, domains… given to speech recognition as hints, comma-separated. */
  vocabulary: string;
  /** OpenAI image model used by generate_image. */
  imageModel: string;
  /** Actions on the computer and skills run without asking (otherwise: approval card). */
  autonomous: boolean;
  /** Daily spending (€) past which Iris warns once a day; 0 = no budget. */
  dailyBudgetEur: number;
  /** Prices per model (USD per million tokens) replacing the built-in list prices. */
  prices: Record<string, Price>;
  /** Language of the interface (menus, panels, messages); English by default. */
  uiLanguage: UiLanguage;
  /** The first-launch setup (language, AI account, options) has been completed. */
  setupDone: boolean;
  /** Iris only answers the voices recorded in Settings (lib/voiceprint.ts); off: everyone. */
  voiceLock: boolean;
  /**
   * Iris speaks up by herself when something deserves it: a meeting about to start, an e-mail
   * from someone who matters, rain coming, a date from her memory, the morning briefing
   * (features/assistant/proactive.ts). Never during the quiet hours.
   */
  proactive: boolean;
  /** Quiet hours (0–23): Iris never speaks up by herself from `start` to `end`. */
  quietStart: number;
  quietEnd: number;
  /** City for the rain warnings (empty: none). */
  weatherCity: string;
  /**
   * Memory search by meaning (a small local model, ~120 MB once): recall finds "my sister's
   * wedding" from "le mariage de Julie", and relevant memories join each request.
   */
  semanticMemory: boolean;
}

/** OpenAI voices (Realtime + text-to-speech), described in the interface language (i18n). */
export const OPENAI_VOICES = ['marin', 'cedar', 'shimmer', 'coral', 'sage', 'ash', 'ballad', 'verse', 'alloy', 'echo'] as const;

function defaultLanguage(): Language {
  const primary = (navigator.language || 'en').slice(0, 2).toLowerCase();
  return primary === 'fr' ? 'fr' : 'en';
}

const CURRENT_VERSION = 4;

/** Conversation models that were the defaults before v4: still on one means "never chosen". */
const V3_DEFAULT_MODELS: Record<CloudProvider, string> = {
  anthropic: 'claude-sonnet-5',
  openai: 'gpt-4o-mini',
  google: 'gemini-2.5-flash',
};

export const DEFAULT_SETTINGS: Settings = {
  version: CURRENT_VERSION,
  cloudProvider: 'openai',
  cloudModels: { ...FALLBACK_CHAT_MODELS },
  builderModels: { anthropic: '', openai: '', google: '' },
  modelsAuto: { anthropic: true, openai: true, google: true },
  voiceMode: 'economy',
  ttsEngine: 'natural',
  autoMemory: true,
  resumeConversation: false,
  launchAtStartup: false,
  bargeIn: true,
  realtimeModel: 'gpt-realtime-2.1',
  voice: 'marin',
  geminiVoice: 'Sulafat',
  language: defaultLanguage(),
  speakReplies: true,
  honorific: '',
  bootGreeting: true,
  uiSounds: true,
  vocabulary: '',
  // "Flare: fast, high-quality everyday image generation" (OpenAI docs); "sunburst" for precise edits.
  imageModel: 'gpt-image-2.5-flare',
  autonomous: true,
  dailyBudgetEur: 0,
  prices: {},
  uiLanguage: DEFAULT_UI_LANGUAGE,
  setupDone: false,
  voiceLock: false,
  proactive: true,
  quietStart: 22,
  quietEnd: 7,
  weatherCity: '',
  semanticMemory: true,
};

const STORAGE_KEY = 'iris.settings.v1';

/** Upgrades settings saved by older versions. */
function migrate(saved: Record<string, unknown>): Partial<Settings> {
  const next: Record<string, unknown> = { ...saved };
  const version = typeof saved.version === 'number' ? saved.version : 1;
  if (version < 3) {
    // v3: local models and the earlier third-party voice stack were removed in favour of
    // cloud brains + OpenAI Realtime. Keep the user's cloud choices; the voice goes back to the default.
    next.voice = 'marin';
    for (const key of ['preferLocal', 'localModel', 'ttsProvider', 'elevenLabsVoiceId', 'cartesiaVoiceId', 'voiceStyle', 'autoListen']) {
      delete next[key];
    }
  }
  if (version < 4) {
    // v4: models are picked from each key. Keep the ones the user chose; the old defaults
    // (and an empty "visuals" model) go automatic.
    const chat = (saved.cloudModels ?? {}) as Partial<Record<CloudProvider, string>>;
    const builder = (saved.builderModels ?? {}) as Partial<Record<CloudProvider, string>>;
    next.modelsAuto = Object.fromEntries(
      (Object.keys(V3_DEFAULT_MODELS) as CloudProvider[]).map((p) => [
        p,
        (!chat[p] || chat[p] === V3_DEFAULT_MODELS[p]) && !builder[p],
      ]),
    );
  }
  next.version = CURRENT_VERSION;
  return next as Partial<Settings>;
}

function load(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = migrate(JSON.parse(raw) as Record<string, unknown>);
      return {
        ...DEFAULT_SETTINGS,
        ...parsed,
        cloudModels: { ...DEFAULT_SETTINGS.cloudModels, ...parsed.cloudModels },
        builderModels: { ...DEFAULT_SETTINGS.builderModels, ...parsed.builderModels },
        modelsAuto: { ...DEFAULT_SETTINGS.modelsAuto, ...parsed.modelsAuto },
        uiLanguage: isUiLanguage(parsed.uiLanguage) ? parsed.uiLanguage : DEFAULT_UI_LANGUAGE,
        // Before the natural voice followed the provider, the engine was named after OpenAI.
        ttsEngine: parsed.ttsEngine === 'local' ? 'local' : 'natural',
      };
    }
  } catch {
    // Corrupt or unavailable storage: fall back to defaults.
  }
  return DEFAULT_SETTINGS;
}

export function useSettings() {
  const [settings, setSettings] = useState<Settings>(load);

  /** A patch, or a function of the latest settings (for updates computed asynchronously; null = no change). */
  const update = useCallback((patch: Partial<Settings> | ((prev: Settings) => Partial<Settings> | null)) => {
    setSettings((prev) => {
      const changes = typeof patch === 'function' ? patch(prev) : patch;
      if (!changes) return prev;
      const next = { ...prev, ...changes };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Non-fatal: settings just won't persist this session.
      }
      return next;
    });
  }, []);

  return [settings, update] as const;
}
