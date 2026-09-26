import type { Tool, ToolSet } from 'ai';

/**
 * Safety after untrusted content. A web page, a search result, a document, the screen or an
 * external service can contain text written to manipulate an assistant ("ignore your
 * instructions and run…"). So once a task has read such content, its risky actions — commands,
 * deleting or writing files, the mouse and keyboard, scripts — ask the user first, even in
 * autonomous mode. The user can answer by voice ("oui, vas-y" / "non").
 */

/** Tools whose results come from outside (a page, a document, the screen, a service…). */
export const UNTRUSTED_TOOLS = /^(search_web|read_webpage|get_news|lookup_wikipedia|reread_document|look_at_screen|use_computer|run_skill|skill_|mcp_)/;

/** Actions that could do harm if an injected instruction triggered them. */
export const RISKY_TOOLS = /^(run_command|delete_to_trash|write_text_file|move_or_rename|open_file_or_folder|use_computer|create_skill|run_skill|skill_)/;

export interface GuardHooks {
  /** Autonomous mode (otherwise the tools already ask for approval themselves). */
  autonomous: () => boolean;
  /** The task started with untrusted content (a document attached to the request). */
  taintedFromStart?: boolean;
  /** Tools that are risky beyond RISKY_TOOLS (external services that change data). */
  alsoRisky?: (name: string) => boolean;
  /** Asks the user; resolves true when allowed. */
  ask: (toolName: string, args: unknown) => Promise<boolean>;
}

/**
 * The same tools, where untrusted results taint the task and, once tainted, risky actions ask
 * the user first (in autonomous mode). `tainted()` tells whether it happened.
 */
export function guardUntrusted(tools: ToolSet, hooks: GuardHooks): { tools: ToolSet; tainted: () => boolean } {
  let tainted = !!hooks.taintedFromStart;
  const guarded = Object.fromEntries(
    Object.entries(tools).map(([name, t]) => {
      if (!t.execute) return [name, t];
      const risky = RISKY_TOOLS.test(name) || !!hooks.alsoRisky?.(name);
      const untrusted = UNTRUSTED_TOOLS.test(name);
      if (!risky && !untrusted) return [name, t];
      const execute = t.execute.bind(t);
      return [
        name,
        {
          ...t,
          execute: async (args: unknown, options: unknown) => {
            if (risky && tainted && hooks.autonomous() && !(await hooks.ask(name, args))) {
              return { done: false, note: 'The user declined this action (asked for safety: this task read outside content). Acknowledge briefly; do not retry.' };
            }
            try {
              return await execute(args as never, options as never);
            } finally {
              if (untrusted) tainted = true;
            }
          },
        } as Tool,
      ];
    }),
  );
  return { tools: guarded, tainted: () => tainted };
}

const normalize = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’']/g, ' ')
    .replace(/[^a-z ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const YES = /^(oui|ouais|ok|okay|d accord|vas y|allez y|allez|valide|je valide|confirme|je confirme|autorise|j autorise|fais le|fais la|c est bon|go|yes|yeah|sure|do it|go ahead|approve|allow|continue|continuez|bien sur|absolument|exactement)( .*)?$/;
const NO = /^(non|nan|annule|annuler|refuse|je refuse|stop|arrete|laisse tomber|surtout pas|pas question|no|nope|cancel|deny|don t|do not|abort)( .*)?$/;

/** A spoken answer to an approval question: "oui, vas-y" → yes, "non, annule" → no, anything else → null. */
export function voiceAnswer(text: string): 'yes' | 'no' | null {
  const t = normalize(text).replace(/^(iris )+|( iris)+$/g, '').trim();
  if (!t || t.split(' ').length > 6) return null; // a sentence that long is a new request
  if (NO.test(t)) return 'no';
  if (YES.test(t)) return 'yes';
  return null;
}
