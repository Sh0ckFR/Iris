import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import type { CloudProvider } from './settings';

/**
 * Lists the chat models a cloud key can use, so Settings offers a picker instead of a free-text
 * field. Free text let a real-time "Live" model (voice-only, WebSocket API) be picked as the
 * brain, which then failed on every request.
 */

/** Models that can't hold a text conversation through the standard API. */
const NOT_CHAT = /live|realtime|real-time|native-audio|audio|tts|transcribe|image|imagen|veo|embedding|embed|moderation|search|aqa|computer-use|robotics|instruct|dall-e|whisper/i;

export function isChatModel(id: string): boolean {
  return !NOT_CHAT.test(id);
}

async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const response = await tauriFetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) {
    // The provider's own explanation (bad key, no credit, region…), shown when a key is checked.
    const body = await response.text().catch(() => '');
    let message = '';
    try {
      const data = JSON.parse(body) as { error?: { message?: string } | string; message?: string };
      message = (typeof data.error === 'object' ? data.error?.message : data.error) ?? data.message ?? '';
    } catch {
      message = body.slice(0, 200);
    }
    throw new Error(message ? `HTTP ${response.status}: ${message}` : `HTTP ${response.status}`);
  }
  return response.json();
}

/** OpenAI speech-to-speech models usable for voice sessions (newest first). */
export async function listRealtimeModels(apiKey: string): Promise<string[]> {
  const data = (await getJson('https://api.openai.com/v1/models', { Authorization: `Bearer ${apiKey}` })) as {
    data?: { id: string; created?: number }[];
  };
  return (data.data ?? [])
    .filter((m) => /realtime/i.test(m.id) && !/transcri|whisper|translat/i.test(m.id))
    .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
    .map((m) => m.id);
}

export async function listChatModels(provider: CloudProvider, apiKey: string): Promise<string[]> {
  let ids: string[] = [];
  if (provider === 'google') {
    const data = (await getJson('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000', {
      'x-goog-api-key': apiKey,
    })) as { models?: { name: string; supportedGenerationMethods?: string[] }[] };
    ids = (data.models ?? [])
      .filter((m) => m.supportedGenerationMethods?.includes('generateContent') && m.name.includes('gemini'))
      .map((m) => m.name.replace(/^models\//, ''));
  } else if (provider === 'openai') {
    const data = (await getJson('https://api.openai.com/v1/models', { Authorization: `Bearer ${apiKey}` })) as {
      data?: { id: string; created?: number }[];
    };
    ids = (data.data ?? [])
      .filter((m) => /^(gpt-|o\d|chatgpt)/.test(m.id))
      .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
      .map((m) => m.id);
  } else {
    const data = (await getJson('https://api.anthropic.com/v1/models?limit=100', {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    })) as { data?: { id: string }[] };
    ids = (data.data ?? []).map((m) => m.id); // already newest first
  }
  return [...new Set(ids.filter(isChatModel))];
}
