import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { resolveLang, type ToolHooks, type VisualBriefing, type VisualFormat } from './tools';
import type { Language } from '../../lib/settings';
import { languageName } from './language';

/**
 * Visuals, like a real assistant: web pages, apps, charts, diagrams, documents, SVG and code are
 * built by the text brain and streamed live into the HUD's Visual panel (never pasted in the chat).
 * The tool call only carries a brief, so it also works from a voice conversation.
 */

export interface VisualHooks extends ToolHooks {
  /** Streams a generation with the text brain; `onText` receives the whole text so far. */
  generate: (system: string, prompt: string, onText: (text: string) => void) => Promise<string>;
  /** The visual on screen, for "make it blue" follow-ups. */
  lastVisual: () => VisualBriefing | null;
}

let seq = 0;
const nextId = () => `vis-${Date.now().toString(36)}-${(seq++).toString(36)}`;

/** Formats written by the builder model (widgets are rendered by the HUD). */
type BuiltFormat = Exclude<VisualFormat, 'widget'>;

function systemFor(format: BuiltFormat, lang: string, codeLanguage?: string): string {
  const texts = `Write every visible text in ${languageName(lang)} unless the brief says otherwise.`;
  const raw = 'Output ONLY the requested content: no explanation before or after, no markdown code fences.';
  switch (format) {
    case 'html':
      return [
        'You are a senior front-end developer and product designer. Build exactly what the brief asks for as ONE complete, self-contained HTML document (<!DOCTYPE html> … </html>) with inline CSS and JavaScript.',
        raw,
        'Design: modern and polished (clear hierarchy, generous spacing, harmonious colours, subtle shadows/gradients, good typography), responsive from a 480 px wide panel to full screen. Interactive elements must work.',
        'You may load libraries from https://cdn.jsdelivr.net or https://cdnjs.cloudflare.com (e.g. Chart.js for charts, Mermaid for diagrams and flowcharts, Leaflet for maps, Three.js for 3D) and fonts from Google Fonts.',
        'Use realistic content, not lorem ipsum. For pictures, use inline SVG, CSS art, emojis or https://picsum.photos placeholders.',
        'The page runs in a sandboxed frame: localStorage, sessionStorage and cookies are unavailable (keep state in variables; wrap any storage access in try/catch).',
        'Put the <style> in the <head> first so the page looks right while it is still loading.',
        texts,
      ].join('\n');
    case 'svg':
      return [
        'You are an expert illustrator and icon designer. Produce ONE standalone SVG image (<svg xmlns="http://www.w3.org/2000/svg" viewBox="…"> … </svg>) matching the brief: clean shapes, harmonious colours, no external resources, no scripts.',
        raw,
        texts,
      ].join('\n');
    case 'markdown':
      return [
        'You are an expert writer and editor. Produce a well-structured document in GitHub-flavoured Markdown matching the brief: title, headings, short paragraphs, lists, tables where they help, bold for key points.',
        raw,
        texts,
      ].join('\n');
    case 'code':
      return [
        `You are a senior software engineer. Write complete, working, idiomatic ${codeLanguage || 'code'} that does exactly what the brief asks, with brief comments where useful.`,
        raw,
        `Comments and user-facing strings in ${languageName(lang)} unless the brief says otherwise.`,
      ].join('\n');
  }
}

/** Removes code fences and stray prose around the generated content. */
export function cleanVisual(text: string, format: VisualFormat): string {
  let out = text.replace(/^\s*```[\w+-]*[ \t]*\r?\n/, '').replace(/\r?\n```\s*$/, '');
  if (format === 'html') {
    const start = out.search(/<!doctype html|<html[\s>]/i);
    if (start > 0) out = out.slice(start);
    const end = out.toLowerCase().lastIndexOf('</html>');
    if (end >= 0) out = out.slice(0, end + 7);
  } else if (format === 'svg') {
    const start = out.search(/<svg[\s>]/i);
    if (start > 0) out = out.slice(start);
    const end = out.toLowerCase().lastIndexOf('</svg>');
    if (end >= 0) out = out.slice(0, end + 6);
  }
  return out;
}

const FORMAT_LABEL: Record<BuiltFormat, [string, string]> = {
  html: ['la page', 'the page'],
  svg: ['l’illustration', 'the illustration'],
  markdown: ['le document', 'the document'],
  code: ['le code', 'the code'],
};

export function createVisualTools(hooks: VisualHooks, defaultLanguage: Language): ToolSet {
  return {
    create_visual: tool({
      description:
        'Create something the user asks you to make, which appears live in the Visual panel of the HUD: web pages, apps, games, custom dashboards, UI mockups, diagrams and flowcharts, reports, letters, CVs, SVG logos and icons, code and scripts. The user can see it, view its code, copy it, save it and open it in the browser. Never paste the code or the document in the chat instead. To SHOW data (places on a map or globe, a chart, a table, key figures, a timeline, a list of results), use show_data instead: its ready-made widgets appear instantly for a fraction of the tokens. Only build data views here when the user explicitly asks you to create or design one.',
      inputSchema: z.object({
        format: z
          .enum(['html', 'svg', 'markdown', 'code'])
          .describe(
            'html: web pages, apps, games, charts (Chart.js), diagrams (Mermaid), interactive or designed content. svg: logos, icons, simple illustrations. markdown: documents, reports, letters, tables, notes. code: a script or program the user will run.',
          ),
        title: z.string().describe("Short title in the user's language, e.g. \"Landing page for my bakery\""),
        brief: z
          .string()
          .describe(
            'Complete specification: purpose, sections, every piece of content and data to include (numbers, names, texts from the conversation or tool results), style wishes. The builder does not see tool results, so include the data.',
          ),
        code_language: z.string().optional().describe('For format "code": e.g. "python", "powershell", "javascript"'),
        revise_previous: z.boolean().optional().describe('true to modify the visual currently on screen (the brief then describes the changes)'),
        language: z.string().optional().describe("Two-letter code of the user's language, e.g. 'fr'"),
      }),
      execute: async ({ format, title, brief, code_language, revise_previous, language }) => {
        const lang = resolveLang(language, defaultLanguage);
        const fr = lang === 'fr';
        // A widget on screen is data, not code to revise: "make it a web page" builds a new visual.
        const onScreen = revise_previous ? hooks.lastVisual() : null;
        const previous = onScreen?.format === 'widget' ? null : onScreen;
        const visual: VisualBriefing = {
          id: nextId(),
          kind: 'visual',
          heading: title,
          format,
          codeLanguage: code_language ?? previous?.codeLanguage,
          content: '',
          status: 'streaming',
        };
        const [fr_, en_] = FORMAT_LABEL[format];
        hooks.onActivity(fr ? `Je crée ${fr_}…` : `Building ${en_}…`);
        hooks.onBriefing(visual);

        const prompt = previous
          ? `Modify the current version below according to this request, keeping everything else unchanged, and output the complete new version.\n\nRequest: ${brief}\n\nCurrent version:\n${previous.content}`
          : brief;

        // Live preview: the panel is refreshed as the content arrives (throttled).
        let last = 0;
        try {
          const text = await hooks.generate(systemFor(format, lang, visual.codeLanguage), prompt, (partial) => {
            const now = Date.now();
            if (now - last < 250) return;
            last = now;
            hooks.onBriefing({ ...visual, content: cleanVisual(partial, visual.format) });
          });
          const content = cleanVisual(text, visual.format);
          if (!content.trim()) throw new Error('The model returned nothing.');
          hooks.onBriefing({ ...visual, content, status: 'done' });
          return {
            shownOnScreen: true,
            title,
            format: visual.format,
            characters: content.length,
            note: 'The result is displayed live in the Visual panel, where the user can view the code, copy, save or open it in the browser. Describe it in one or two short sentences and offer a change; never paste its content in the chat.',
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          hooks.onBriefing({ ...visual, status: 'error', error: message });
          throw error;
        } finally {
          hooks.onActivity(null);
        }
      },
    }),
  };
}
