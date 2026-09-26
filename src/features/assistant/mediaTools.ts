import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { invoke } from '@tauri-apps/api/core';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import type { ToolHooks } from './tools';
import type { MediaProvider } from '../../lib/providers';

/**
 * Image generation with the provider that has it (OpenAI Images, or Gemini's image model);
 * results are shown in the HUD and saved to disk.
 */

const SIZES = { square: '1024x1024', landscape: '1536x1024', portrait: '1024x1536' } as const;
/** Gemini takes the shape as part of the request. */
const SHAPES = { square: 'square (1:1)', landscape: 'landscape (3:2)', portrait: 'portrait (2:3)' } as const;
/** Gemini's image model when the key's list can't be read. */
const GEMINI_IMAGE_FALLBACK = 'gemini-2.5-flash-image';

let seq = 0;
const nextId = () => `img-${Date.now().toString(36)}-${(seq++).toString(36)}`;

type Result = { b64: string; mime: string } | { error: string };

const errorText = async (response: Response) => {
  const body = await response.text().catch(() => '');
  try {
    return (JSON.parse(body) as { error?: { message?: string } }).error?.message ?? body;
  } catch {
    return body;
  }
};

async function withOpenAI(apiKey: string, model: string, prompt: string, format: keyof typeof SIZES, transparent?: boolean): Promise<Result> {
  const response = await tauriFetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt,
      size: SIZES[format],
      quality: 'auto',
      output_format: 'png',
      ...(transparent ? { background: 'transparent' } : {}),
    }),
    // High-quality images can take a while.
    signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok) return { error: `Image generation failed (HTTP ${response.status}): ${(await errorText(response)).slice(0, 200)}` };
  const data = (await response.json()) as { data?: { b64_json?: string }[] };
  const b64 = data.data?.[0]?.b64_json;
  return b64 ? { b64, mime: 'image/png' } : { error: 'The image service returned no image.' };
}

let geminiImageModel: Promise<string> | null = null;

/** The newest Gemini model this key can use that draws images through generateContent. */
function pickGeminiImageModel(apiKey: string): Promise<string> {
  geminiImageModel ??= (async () => {
    try {
      const response = await tauriFetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000', {
        headers: { 'x-goog-api-key': apiKey },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return GEMINI_IMAGE_FALLBACK;
      const data = (await response.json()) as { models?: { name: string; supportedGenerationMethods?: string[] }[] };
      const version = (id: string) => Number(/(\d+(?:\.\d+)?)/.exec(id)?.[1] ?? 0);
      const found = (data.models ?? [])
        .map((m) => ({ id: m.name.replace(/^models\//, ''), methods: m.supportedGenerationMethods ?? [] }))
        .filter((m) => /^gemini.*image/i.test(m.id) && m.methods.includes('generateContent'))
        .sort((a, b) => Number(/flash/.test(b.id)) - Number(/flash/.test(a.id)) || version(b.id) - version(a.id));
      return found[0]?.id ?? GEMINI_IMAGE_FALLBACK;
    } catch {
      return GEMINI_IMAGE_FALLBACK;
    }
  })();
  geminiImageModel.catch(() => (geminiImageModel = null));
  return geminiImageModel;
}

async function withGemini(apiKey: string, prompt: string, format: keyof typeof SIZES, transparent?: boolean): Promise<Result> {
  const model = await pickGeminiImageModel(apiKey);
  const request = `Create an image, ${SHAPES[format]}${transparent ? ', on a plain white background' : ''}: ${prompt}`;
  const response = await tauriFetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: request }] }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'] } }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok) return { error: `Image generation failed (HTTP ${response.status}): ${(await errorText(response)).slice(0, 200)}` };
  const data = (await response.json()) as {
    candidates?: { content?: { parts?: { inlineData?: { data?: string; mimeType?: string } }[] } }[];
  };
  const image = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data && /^image\//.test(p.inlineData.mimeType ?? ''))?.inlineData;
  return image?.data ? { b64: image.data, mime: image.mimeType ?? 'image/png' } : { error: 'The image service returned no image.' };
}

export function createMediaTools(
  hooks: ToolHooks,
  options: { provider: MediaProvider | null; apiKey?: string; imageModel: string; fr: boolean },
): ToolSet {
  const t = (a: string, b: string) => (options.fr ? a : b);
  return {
    generate_image: tool({
      description:
        'Create an image from a description (illustration, photo-like picture, logo, poster…). The image is shown on screen and saved in the Pictures/Iris folder.',
      inputSchema: z.object({
        prompt: z.string().describe('Detailed description of the image, in English for best results'),
        format: z.enum(['square', 'landscape', 'portrait']).optional().describe('Default: square'),
        transparent: z.boolean().optional().describe('Transparent background (logos, stickers)'),
      }),
      execute: async ({ prompt, format, transparent }) => {
        if (!options.provider || !options.apiKey) {
          return { error: 'Image generation needs an OpenAI or Gemini key (Settings → AI account). Tell the user.' };
        }
        hooks.onActivity(t('Je génère l’image…', 'Generating the image…'));
        try {
          const result =
            options.provider === 'openai'
              ? await withOpenAI(options.apiKey, options.imageModel, prompt, format ?? 'square', transparent)
              : await withGemini(options.apiKey, prompt, format ?? 'square', transparent);
          if ('error' in result) return result;
          const extension = result.mime.includes('jpeg') ? 'jpg' : result.mime.includes('webp') ? 'webp' : 'png';
          const path = await invoke<string>('save_image', { base64Data: result.b64, extension });
          hooks.onBriefing({
            id: nextId(),
            kind: 'image',
            heading: t('Image', 'Image'),
            prompt,
            dataUrl: `data:${result.mime};base64,${result.b64}`,
            path,
          });
          return { done: true, shownOnScreen: true, savedTo: path };
        } finally {
          hooks.onActivity(null);
        }
      },
    }),
  };
}
