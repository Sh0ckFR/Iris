import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { invoke } from '@tauri-apps/api/core';
import type { Language } from '../../lib/settings';
import { resolveLang, type Briefing, type FileEntry, type ToolHooks } from './tools';
import { OS_NAME, PLATFORM, type Platform } from '../../lib/platform';

/**
 * OS control. In autonomous mode (the default, Settings) actions run straight away; otherwise
 * human-in-the-loop:
 *  - the model proposes an action as a tool call,
 *  - the HUD shows it to the user as an approval card,
 *  - only after "Allow" does Rust execute it (src-tauri/src/system.rs).
 * Listing a folder is read-only and never asks.
 */

export type Risk = 'low' | 'medium' | 'high';

export interface ActionRequest {
  id: string;
  title: string;
  /** Exact parameters, shown verbatim so the user knows precisely what will run. */
  details: { label: string; value: string; mono?: boolean }[];
  risk: Risk;
  /** Offered as "Always allow" (e.g. a skill the user trusts); called before approving. */
  onAlways?: () => void;
}

export interface OsHooks extends ToolHooks {
  /** Resolves true when the user allows the action, false when they decline. */
  requestApproval: (request: ActionRequest) => Promise<boolean>;
  /** Autonomous mode (Settings): actions run straight away, no approval card. */
  autonomous?: boolean;
}

/** Well-known folders, injected into the system prompt so the model can build real paths. */
export interface OsContext {
  os: string;
  user: string;
  home: string;
  desktop?: string | null;
  documents?: string | null;
  downloads?: string | null;
  pictures?: string | null;
  music?: string | null;
  videos?: string | null;
}

let context: Promise<OsContext> | null = null;
export function loadOsContext(): Promise<OsContext> {
  context ??= invoke<OsContext>('os_context').catch((e) => {
    context = null;
    throw e;
  });
  return context;
}

export function describeOsContext(c: OsContext): string {
  const os = OS_NAME[c.os as Platform] ?? c.os;
  const folders = [
    ['Home', c.home],
    ['Desktop', c.desktop],
    ['Documents', c.documents],
    ['Downloads', c.downloads],
    ['Pictures', c.pictures],
    ['Music', c.music],
    ['Videos', c.videos],
  ]
    .filter(([, p]) => p)
    .map(([n, p]) => `${n}: ${p}`)
    .join('; ');
  return `The computer runs ${os} (user "${c.user}"). Known folders — ${folders}. Always use absolute paths built from these.`;
}

let seq = 0;
const nextId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(seq++).toString(36)}`;

export function createOsTools(hooks: OsHooks, defaultLanguage: Language): ToolSet {
  const fr = resolveLang(undefined, defaultLanguage) === 'fr';
  const t = (frText: string, enText: string) => (fr ? frText : enText);

  /**
   * Asks the user (unless Iris is autonomous), then runs `action` in Rust. Declines are
   * reported back to the model.
   */
  const approved = async (request: Omit<ActionRequest, 'id'>, action: () => Promise<string>) => {
    if (hooks.autonomous) {
      hooks.onActivity(`${request.title}…`);
      try {
        return { done: true, result: await action() };
      } finally {
        hooks.onActivity(null);
      }
    }
    hooks.onActivity(t('En attente de votre accord…', 'Waiting for your approval…'));
    let ok = false;
    try {
      ok = await hooks.requestApproval({ ...request, id: nextId('act') });
    } finally {
      hooks.onActivity(null);
    }
    if (!ok) return { done: false, note: 'The user declined this action. Acknowledge briefly; do not retry.' };
    return { done: true, result: await action() };
  };

  const pathParam = (what: string) => z.string().describe(`Absolute path of the ${what}`);

  return {
    open_app: tool({
      description: 'Launch an application installed on this computer (e.g. "calculator", "music player", "calculatrice").',
      inputSchema: z.object({ name: z.string().describe('Application name as the user said it') }),
      execute: ({ name }) =>
        approved(
          { title: t(`Ouvrir l'application « ${name} »`, `Open the app "${name}"`), details: [{ label: t('Application', 'App'), value: name }], risk: 'low' },
          () => invoke<string>('os_open_app', { name }),
        ),
    }),

    set_volume: tool({
      description: 'Turn the computer volume up or down, or mute / unmute it.',
      inputSchema: z.object({
        action: z.enum(['up', 'down', 'mute']).describe('mute toggles mute on / off'),
        steps: z.number().int().min(1).max(50).optional().describe('How much, about 2 % per step (default 5)'),
      }),
      execute: ({ action, steps }) =>
        approved(
          { title: t('Régler le volume', 'Change the volume'), details: [{ label: 'Action', value: action }], risk: 'low' },
          () => invoke<string>('os_volume', { action, steps: steps ?? 5 }),
        ),
    }),

    open_website: tool({
      description: 'Open a website in the default browser, only when the user explicitly asks to open/go to a site.',
      inputSchema: z.object({ url: z.string().describe('Full URL, e.g. https://www.youtube.com') }),
      execute: ({ url }) =>
        approved(
          { title: t('Ouvrir un site web', 'Open a website'), details: [{ label: 'URL', value: url, mono: true }], risk: 'low' },
          () => invoke<string>('os_open_url', { url }),
        ),
    }),

    open_file_or_folder: tool({
      description: 'Open a file with its default application, or a folder in the file explorer.',
      inputSchema: z.object({ path: pathParam('file or folder') }),
      execute: ({ path }) =>
        approved(
          { title: t('Ouvrir', 'Open'), details: [{ label: t('Chemin', 'Path'), value: path, mono: true }], risk: 'low' },
          () => invoke<string>('os_open_path', { path }),
        ),
    }),

    list_folder: tool({
      description: 'List the files and sub-folders of a folder. The listing is displayed on screen.',
      inputSchema: z.object({ path: pathParam('folder') }),
      execute: async ({ path }) => {
        const listing = await invoke<{ path: string; entries: FileEntry[]; truncated: boolean }>('os_list_dir', { path });
        const name = listing.path.split(/[\\/]/).filter(Boolean).pop() ?? listing.path;
        const briefing: Briefing = { id: nextId('b'), kind: 'files', heading: name, ...listing };
        hooks.onBriefing(briefing);
        const folders = listing.entries.filter((e) => e.isDir).length;
        return {
          shownOnScreen: true,
          summary: `${listing.entries.length} items (${folders} folders)${listing.truncated ? ', list truncated' : ''}.`,
          items: listing.entries.slice(0, 60).map((e) => (e.isDir ? `${e.name}/` : e.name)),
        };
      },
    }),

    create_folder: tool({
      description: 'Create a new folder (and missing parent folders).',
      inputSchema: z.object({ path: pathParam('folder to create') }),
      execute: ({ path }) =>
        approved(
          { title: t('Créer un dossier', 'Create a folder'), details: [{ label: t('Chemin', 'Path'), value: path, mono: true }], risk: 'medium' },
          () => invoke<string>('os_create_dir', { path }),
        ),
    }),

    write_text_file: tool({
      description: 'Create a text file with the given content. Refuses to overwrite unless overwrite is true.',
      inputSchema: z.object({
        path: pathParam('file to write'),
        content: z.string().describe('Full text content of the file'),
        overwrite: z.boolean().optional().describe('Replace the file if it already exists'),
      }),
      execute: ({ path, content, overwrite }) =>
        approved(
          {
            title: overwrite ? t('Remplacer un fichier', 'Overwrite a file') : t('Créer un fichier', 'Create a file'),
            details: [
              { label: t('Chemin', 'Path'), value: path, mono: true },
              { label: t('Contenu', 'Content'), value: content.length > 400 ? `${content.slice(0, 400)}…` : content, mono: true },
            ],
            risk: overwrite ? 'high' : 'medium',
          },
          () => invoke<string>('os_write_file', { path, content, overwrite: !!overwrite }),
        ),
    }),

    move_or_rename: tool({
      description: 'Move or rename a file or folder. Never overwrites an existing destination.',
      inputSchema: z.object({ from: pathParam('source file or folder'), to: pathParam('destination (or destination folder)') }),
      execute: ({ from, to }) =>
        approved(
          {
            title: t('Déplacer / renommer', 'Move / rename'),
            details: [
              { label: t('De', 'From'), value: from, mono: true },
              { label: t('Vers', 'To'), value: to, mono: true },
            ],
            risk: 'medium',
          },
          () => invoke<string>('os_move', { from, to }),
        ),
    }),

    delete_to_trash: tool({
      description: 'Delete a file or folder by moving it to the Recycle Bin / Trash (recoverable).',
      inputSchema: z.object({ path: pathParam('file or folder to delete') }),
      execute: ({ path }) =>
        approved(
          { title: t('Mettre à la corbeille', PLATFORM === 'windows' ? 'Move to the Recycle Bin' : 'Move to the Trash'), details: [{ label: t('Chemin', 'Path'), value: path, mono: true }], risk: 'high' },
          () => invoke<string>('os_trash', { path }),
        ),
    }),

    run_command: tool({
      description:
        `Run a ${PLATFORM === 'windows' ? 'PowerShell' : 'sh (POSIX shell)'} command on this ${OS_NAME[PLATFORM]} computer, in the home folder, and get its output. Use only when no other tool fits.`,
      inputSchema: z.object({
        command: z.string().describe('The exact command line to run'),
        purpose: z.string().describe('One short sentence explaining what the command does, for the user'),
      }),
      execute: async ({ command, purpose }) => {
        const res = await approved(
          {
            title: t('Exécuter une commande', 'Run a command'),
            details: [
              { label: t('But', 'Purpose'), value: purpose },
              { label: t('Commande', 'Command'), value: command, mono: true },
            ],
            risk: 'high',
          },
          async () => {
            const out = await invoke<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }>('os_run_command', { command });
            hooks.onBriefing({ id: nextId('b'), kind: 'command', heading: t('Commande', 'Command'), command, ...out });
            const status = out.timedOut ? 'timed out after 60 s' : `exit code ${out.exitCode}`;
            return `${status}\n${out.stdout.slice(0, 3000)}${out.stderr ? `\nstderr: ${out.stderr.slice(0, 1000)}` : ''}`;
          },
        );
        return res;
      },
    }),
  };
}

export const OS_TOOL_NAMES = [
  'open_app',
  'set_volume',
  'open_website',
  'open_file_or_folder',
  'list_folder',
  'create_folder',
  'write_text_file',
  'move_or_rename',
  'delete_to_trash',
  'run_command',
] as const;
