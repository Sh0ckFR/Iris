import type { Secrets } from './secrets';
import type { CloudProvider, Settings } from './settings';

/**
 * What each AI provider brings. Connecting one provider sets everything up: its key answers the
 * conversation, and — for OpenAI and Gemini — speaks with a natural voice and creates images.
 * Anthropic has neither: connected to it, Iris uses her free local voice, or an extra OpenAI or
 * Gemini key given for voice and images only.
 */

export const PROVIDERS: CloudProvider[] = ['openai', 'google', 'anthropic'];

/** Providers whose API also speaks (text-to-speech) and draws (image generation). */
export type MediaProvider = 'openai' | 'google';

export const PROVIDER_INFO: Record<CloudProvider, { name: string; keyPage: string; keyPrefix?: RegExp }> = {
  openai: { name: 'OpenAI', keyPage: 'https://platform.openai.com/api-keys', keyPrefix: /^sk-/ },
  google: { name: 'Gemini', keyPage: 'https://aistudio.google.com/apikey', keyPrefix: /^AIza/ },
  anthropic: { name: 'Anthropic', keyPage: 'https://console.anthropic.com/settings/keys', keyPrefix: /^sk-ant-/ },
};

/** The provider Iris is connected to, if its key is there. */
export function connectedProvider(settings: Settings, secrets: Secrets): CloudProvider | null {
  return secrets[settings.cloudProvider] ? settings.cloudProvider : null;
}

/**
 * Where the natural voice and the images come from: the connected provider when it has them,
 * otherwise the extra key given for them (OpenAI first), or none.
 */
export function mediaProvider(settings: Settings, secrets: Secrets): MediaProvider | null {
  const main = connectedProvider(settings, secrets);
  if (main === 'openai' || main === 'google') return main;
  if (secrets.openai) return 'openai';
  if (secrets.google) return 'google';
  return null;
}

/** The premium voice mode (speech to speech in real time) needs OpenAI Realtime. */
export const hasRealtime = (secrets: Secrets) => !!secrets.openai;
