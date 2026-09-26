import { useSyncExternalStore } from 'react';
import { en, type Messages } from './en';
import { ar } from './ar';
import { de } from './de';
import { es } from './es';
import { fr } from './fr';
import { hi } from './hi';
import { id } from './id';
import { it } from './it';
import { ja } from './ja';
import { ko } from './ko';
import { pt } from './pt';
import { ru } from './ru';
import { tr } from './tr';
import { zh } from './zh';

export type { Messages };

/**
 * The interface languages. To add one: copy en.ts to <code>.ts, translate every string (the
 * `Messages` type makes a missing key a compile error), and list it here.
 * `locale` formats dates and numbers; `rtl` lays text out right to left.
 */
interface LanguageInfo {
  /** The language's own name, as listed in Settings. */
  name: string;
  locale: string;
  rtl?: boolean;
  messages: Messages;
}

export const LANGUAGES = {
  en: { name: 'English', locale: 'en-GB', messages: en },
  zh: { name: '中文（简体）', locale: 'zh-CN', messages: zh },
  hi: { name: 'हिन्दी', locale: 'hi-IN', messages: hi },
  es: { name: 'Español', locale: 'es-ES', messages: es },
  fr: { name: 'Français', locale: 'fr-FR', messages: fr },
  ar: { name: 'العربية', locale: 'ar', rtl: true, messages: ar },
  pt: { name: 'Português (Brasil)', locale: 'pt-BR', messages: pt },
  ru: { name: 'Русский', locale: 'ru-RU', messages: ru },
  ja: { name: '日本語', locale: 'ja-JP', messages: ja },
  de: { name: 'Deutsch', locale: 'de-DE', messages: de },
  id: { name: 'Bahasa Indonesia', locale: 'id-ID', messages: id },
  it: { name: 'Italiano', locale: 'it-IT', messages: it },
  ko: { name: '한국어', locale: 'ko-KR', messages: ko },
  tr: { name: 'Türkçe', locale: 'tr-TR', messages: tr },
} satisfies Record<string, LanguageInfo>;

export type UiLanguage = keyof typeof LANGUAGES;
export const DEFAULT_UI_LANGUAGE: UiLanguage = 'en';

export const isUiLanguage = (value: unknown): value is UiLanguage => typeof value === 'string' && value in LANGUAGES;

/** Where the settings are saved (lib/settings.ts): read here too, by the mini window. */
const SETTINGS_KEY = 'iris.settings.v1';

function savedLanguage(): UiLanguage {
  try {
    const saved = (JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as { uiLanguage?: unknown }).uiLanguage;
    return isUiLanguage(saved) ? saved : DEFAULT_UI_LANGUAGE;
  } catch {
    return DEFAULT_UI_LANGUAGE;
  }
}

let current: UiLanguage = DEFAULT_UI_LANGUAGE;
const listeners = new Set<() => void>();

function apply(lang: UiLanguage) {
  current = lang;
  const info: LanguageInfo = LANGUAGES[lang];
  if (typeof document === 'undefined') return; // unit tests
  document.documentElement.lang = lang;
  document.documentElement.classList.toggle('rtl', !!info.rtl);
}
apply(savedLanguage());

// The mini window is another page: it follows the language saved by the main window.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === SETTINGS_KEY) setUiLanguage(savedLanguage());
  });
}

export function setUiLanguage(lang: UiLanguage) {
  if (lang === current) return;
  apply(lang);
  listeners.forEach((l) => l());
}

export const uiLanguage = () => current;

/** The current language's strings, for code outside React components. */
export const t = (): Messages => LANGUAGES[current].messages;

/** BCP 47 locale of the interface, for dates and numbers. */
export const uiLocale = () => LANGUAGES[current].locale;

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** The current language's strings; the component re-renders when the language changes. */
export function useT(): Messages {
  useSyncExternalStore(subscribe, uiLanguage);
  return t();
}
