import type { ModelMessage } from 'ai';

/**
 * Lighter multi-step requests. Every step of a request re-sends everything before it, including
 * the results of the tools called at the earlier steps: a web page read at step 1 (~1,000 tokens)
 * was paid again at steps 2, 3, 4… The model has already used those results (it decided what to
 * do next from them), so from the step after, long ones are cut to their start with a note; the
 * latest results stay complete. The model can call the tool again if it needs the rest.
 */

/** Results longer than this (characters) are shortened once they are no longer the latest. */
export const KEEP_CHARS = 700;

const NOTE = '… [shortened: you already used this result at an earlier step; call the tool again if you need the rest]';

type ToolMessage = Extract<ModelMessage, { role: 'tool' }>;
type ToolPart = ToolMessage['content'][number];

function shorten(part: ToolPart): ToolPart {
  if (part.type !== 'tool-result') return part;
  const output = part.output as { type: string; value?: unknown };
  let text: string | null = null;
  if (output.type === 'text' || output.type === 'error-text') text = String(output.value ?? '');
  else if (output.type === 'json' || output.type === 'error-json') text = JSON.stringify(output.value);
  if (text === null || text.length <= KEEP_CHARS) return part; // images, short results: unchanged
  return { ...part, output: { type: 'text', value: text.slice(0, KEEP_CHARS) + NOTE } } as ToolPart;
}

/**
 * The messages for the next step with the older tool results shortened (the last tool message —
 * the results the model is about to read — stays intact). Returns null when nothing changes.
 */
export function compactOldToolResults(messages: ModelMessage[]): ModelMessage[] | null {
  const lastTool = messages.map((m) => m.role).lastIndexOf('tool');
  if (lastTool <= 0) return null;
  let changed = false;
  const next = messages.map((m, i) => {
    if (m.role !== 'tool' || i === lastTool) return m;
    const content = m.content.map(shorten);
    if (content.some((part, k) => part !== m.content[k])) {
      changed = true;
      return { ...m, content };
    }
    return m;
  });
  return changed ? next : null;
}
