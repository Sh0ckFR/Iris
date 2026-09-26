import { describe, expect, it, vi } from 'vitest';

/** A fake Gemini API that refuses cachedContent together with the instructions or tools, like the real one. */
const calls: { url: string; body: Record<string, unknown> | null }[] = [];
vi.mock('@tauri-apps/plugin-http', () => ({
  fetch: vi.fn(async (url: string, init?: { body?: string }) => {
    const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    calls.push({ url, body });
    if (url.endsWith('/cachedContents')) return new Response(JSON.stringify({ name: 'cachedContents/abc', usageMetadata: { totalTokenCount: 5000 } }));
    if (body?.cachedContent && (body.tools || body.systemInstruction)) return new Response('{}', { status: 400 });
    return new Response('data: {}\n\n');
  }),
}));
const { geminiCachingFetch } = await import('./geminiCache');

const URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash:streamGenerateContent?alt=sse';
const request = (system: string) =>
  JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }], systemInstruction: { parts: [{ text: system }] }, tools: [{ functionDeclarations: [{ name: 'a' }] }] });

describe('explicit Gemini cache', () => {
  it('creates the cache the first time a prefix is seen, then references it', async () => {
    const fetch = geminiCachingFetch('KEY');
    const body = request('x'.repeat(6000));
    for (let i = 0; i < 3; i++) {
      expect((await fetch(URL, { method: 'POST', body })).status).toBe(200);
      await new Promise((r) => setTimeout(r, 10)); // the cache is created in the background
    }
    const generate = calls.filter((c) => c.url.includes(':stream'));
    expect(calls.some((c) => c.url.endsWith('/cachedContents'))).toBe(true);
    expect(generate[0].body).toHaveProperty('tools'); // sent in full while the cache is made
    expect(generate[1].body).toMatchObject({ cachedContent: 'cachedContents/abc' }); // the next step uses it
    expect(generate[1].body).not.toHaveProperty('tools');
    expect(generate[1].body).not.toHaveProperty('systemInstruction');
    expect(calls.filter((c) => c.url.endsWith('/cachedContents'))).toHaveLength(1);
  });

  it('leaves small prompts alone', async () => {
    calls.length = 0;
    const fetch = geminiCachingFetch('KEY');
    for (let i = 0; i < 3; i++) await fetch(URL, { method: 'POST', body: request('short') });
    expect(calls.every((c) => !c.url.endsWith('/cachedContents') && !c.body?.cachedContent)).toBe(true);
  });
});
