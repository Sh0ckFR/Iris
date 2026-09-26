import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }));
const { markModelUnavailable, pickModels } = await import('./modelDefaults');

describe('pickModels: models chosen from what a key can use', () => {
  it('OpenAI: newest mini for the conversation, newest full model for visuals (no nano, no pro)', () => {
    const ids = ['gpt-5.2', 'gpt-5.2-pro', 'gpt-5-mini', 'gpt-5-mini-2025-08-07', 'gpt-5.1-mini', 'gpt-5-nano', 'gpt-5', 'gpt-5-chat-latest', 'gpt-4o-mini'];
    expect(pickModels('openai', ids)).toEqual({ chat: 'gpt-5.1-mini', builder: 'gpt-5.2' });
    expect(pickModels('openai', ['gpt-4o-mini'])).toEqual({ chat: 'gpt-4o-mini', builder: null });
  });

  it('Anthropic: newest Haiku and Sonnet (the list is newest first)', () => {
    expect(pickModels('anthropic', ['claude-opus-5-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001', 'claude-3-5-haiku-20241022'])).toEqual({
      chat: 'claude-haiku-4-5-20251001',
      builder: 'claude-sonnet-5',
    });
  });

  it('Gemini: the newest generation, stable before preview at the same version', () => {
    const ids = ['gemini-3.1-pro-preview', 'gemini-3-flash-preview', 'gemini-3-flash', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro'];
    expect(pickModels('google', ids)).toEqual({ chat: 'gemini-3-flash', builder: 'gemini-3.1-pro-preview' });
  });

  it('skips a model its provider refused, and picks the next one', () => {
    markModelUnavailable('gemini-3.1-pro-preview'); // "no longer available to new users"
    expect(pickModels('google', ['gemini-3.1-pro-preview', 'gemini-2.5-pro']).builder).toBe('gemini-2.5-pro');
  });
});
