import { describe, expect, it } from 'vitest';
import type { ModelMessage } from 'ai';
import { compactOldToolResults, KEEP_CHARS } from './compactSteps';

const page = 'Texte de la page. '.repeat(300); // ~5,400 characters, like read_webpage
const call = (id: string, toolName: string): ModelMessage => ({
  role: 'assistant',
  content: [{ type: 'tool-call', toolCallId: id, toolName, input: {} }],
});
const result = (id: string, toolName: string, value: unknown): ModelMessage => ({
  role: 'tool',
  content: [{ type: 'tool-result', toolCallId: id, toolName, output: typeof value === 'string' ? { type: 'text', value } : { type: 'json', value: value as never } }],
});
const outputOf = (m: ModelMessage) => (m as Extract<ModelMessage, { role: 'tool' }>).content[0] as { output: { type: string; value: unknown } };

describe('older tool results are shortened between steps', () => {
  const messages: ModelMessage[] = [
    { role: 'user', content: 'Compare ces deux pages' },
    call('1', 'read_webpage'),
    result('1', 'read_webpage', { title: 'Page 1', content: page }),
    call('2', 'read_webpage'),
    result('2', 'read_webpage', { title: 'Page 2', content: page }),
  ];

  it('cuts the earlier long results, keeps the latest one whole', () => {
    const next = compactOldToolResults(messages)!;
    const first = outputOf(next[2]).output;
    expect(first.type).toBe('text');
    expect(String(first.value).length).toBeLessThan(KEEP_CHARS + 200);
    expect(String(first.value)).toContain('shortened');
    expect(outputOf(next[4]).output).toEqual(outputOf(messages[4]).output); // the latest: intact
    // Shorter, and the conversation and the calls are untouched (the ids still match).
    expect(JSON.stringify(next).length).toBeLessThan(JSON.stringify(messages).length - 4000);
    expect(next[0]).toBe(messages[0]);
    expect(next[1]).toBe(messages[1]);
  });

  it('leaves short results and single-step requests alone', () => {
    expect(compactOldToolResults([messages[0], call('1', 'get_weather'), result('1', 'get_weather', { summary: '12 °C' }), call('2', 'x'), result('2', 'x', 'ok')])).toBeNull();
    expect(compactOldToolResults(messages.slice(0, 3))).toBeNull();
  });
});
