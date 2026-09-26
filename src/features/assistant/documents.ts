import { tool, type ModelMessage, type ToolSet } from 'ai';
import { unzipSync } from 'fflate';
import { z } from 'zod';

/**
 * Files the user attaches (📎 button or drag & drop). PDFs and images are sent to the model as
 * they are — Claude, Gemini and OpenAI all read them natively, layout and tables included —
 * while Word and text files are converted to text here.
 */

export type AttachmentKind = 'pdf' | 'image' | 'text';

export interface Attachment {
  id: string;
  name: string;
  size: number;
  kind: AttachmentKind;
  mediaType: string;
  /** pdf / image: the raw bytes. */
  data?: Uint8Array;
  /** text: the extracted text. */
  text?: string;
}

const MAX_BINARY = 25 * 1024 * 1024; // providers accept ~20-32 MB per PDF
const MAX_TEXT_CHARS = 150_000;

const TEXT_EXTENSIONS = /\.(txt|md|markdown|csv|tsv|json|xml|html?|css|js|jsx|ts|tsx|py|rs|java|c|cpp|h|cs|go|rb|php|sh|ps1|sql|yaml|yml|toml|ini|log|srt)$/i;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

export const ACCEPTED_FILES = '.pdf,.docx,.png,.jpg,.jpeg,.webp,.gif,.txt,.md,.csv,.tsv,.json,.xml,.html,.htm,.log,.yaml,.yml,.py,.js,.ts,.tsx,.sql';

let seq = 0;
const nextId = () => `att-${Date.now().toString(36)}-${(seq++).toString(36)}`;

function clipText(text: string): string {
  return text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}\n\n[… document truncated]` : text;
}

/** Plain text of a .docx (paragraphs, line breaks, tabs; tables become one cell per line). */
export function docxToText(bytes: Uint8Array): string {
  const files = unzipSync(bytes, { filter: (f) => f.name === 'word/document.xml' });
  const xml = files['word/document.xml'];
  if (!xml) throw new Error('Not a valid Word document.');
  const doc = new DOMParser().parseFromString(new TextDecoder().decode(xml), 'application/xml');
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const paragraphs = Array.from(doc.getElementsByTagNameNS(W, 'p')).map((p) => {
    let line = '';
    // Descendants in document order: text runs, tabs and line breaks.
    for (const node of Array.from(p.getElementsByTagName('*'))) {
      if (node.namespaceURI !== W) continue;
      if (node.localName === 't') line += node.textContent ?? '';
      else if (node.localName === 'tab') line += '\t';
      else if (node.localName === 'br') line += '\n';
    }
    return line;
  });
  return paragraphs.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Reads a dropped / picked file into an attachment, or throws a user-facing error. */
export async function prepareAttachment(file: File): Promise<Attachment> {
  const name = file.name;
  const lower = name.toLowerCase();
  const base = { id: nextId(), name, size: file.size };

  if (lower.endsWith('.pdf') || file.type === 'application/pdf') {
    if (file.size > MAX_BINARY) throw new Error(`${name}: PDF too large (max 25 MB).`);
    return { ...base, kind: 'pdf', mediaType: 'application/pdf', data: new Uint8Array(await file.arrayBuffer()) };
  }
  if (IMAGE_TYPES.includes(file.type)) {
    if (file.size > MAX_BINARY) throw new Error(`${name}: image too large (max 25 MB).`);
    return { ...base, kind: 'image', mediaType: file.type, data: new Uint8Array(await file.arrayBuffer()) };
  }
  if (lower.endsWith('.docx')) {
    const text = docxToText(new Uint8Array(await file.arrayBuffer()));
    return { ...base, kind: 'text', mediaType: 'text/plain', text: clipText(text) };
  }
  if (TEXT_EXTENSIONS.test(lower) || file.type.startsWith('text/')) {
    return { ...base, kind: 'text', mediaType: file.type || 'text/plain', text: clipText(await file.text()) };
  }
  if (lower.endsWith('.doc') || lower.endsWith('.xlsx') || lower.endsWith('.xls') || lower.endsWith('.pptx')) {
    throw new Error(`${name}: this format isn't supported yet. Export it as PDF (or CSV for spreadsheets).`);
  }
  throw new Error(`${name}: unsupported file type.`);
}

// ---------------------------------------------------------------- documents in the conversation

type UserPart =
  | { type: 'text'; text: string }
  | { type: 'file'; data: Uint8Array; mediaType: string; filename?: string }
  | { type: 'image'; image: Uint8Array; mediaType?: string };

/** Message content for the model: text plus attached documents (PDF/images natively). */
export function userContent(text: string, attachments: Attachment[]): string | UserPart[] {
  if (attachments.length === 0) return text;
  const parts: UserPart[] = [{ type: 'text', text }];
  for (const a of attachments) {
    if (a.kind === 'pdf' && a.data) parts.push({ type: 'file', data: a.data, mediaType: a.mediaType, filename: a.name });
    else if (a.kind === 'image' && a.data) parts.push({ type: 'image', image: a.data, mediaType: a.mediaType });
    else if (a.text !== undefined) parts.push({ type: 'text', text: `Document « ${a.name} » :\n\n${a.text}` });
  }
  return parts;
}

/**
 * Documents are costly (a PDF page is worth hundreds of tokens) and every message sends the
 * whole conversation again. So a document is sent with its question and this many follow-up
 * questions; after that its message only names it, and reread_document brings it back when a
 * later question needs it.
 */
export const DOCUMENT_FOLLOW_UPS = 2;

/** An earlier message whose documents are no longer sent: just their names. */
export function documentNote(text: string, attachments: Attachment[]): string {
  const names = attachments.map((a) => `« ${a.name} »`).join(', ');
  return `${text}\n\n[Attached with this message: ${names}. Not included anymore, to save tokens: call reread_document if a question needs it again.]`;
}

/**
 * reread_document, for documents that are no longer sent: the model asks for one by name and it
 * is added to the conversation before its next step (see `inject`).
 */
export function createDocumentTools(earlier: Attachment[]) {
  const pending: Attachment[] = [];
  const tools: ToolSet = {
    reread_document: tool({
      description:
        'Read again a document the user attached earlier in the conversation (it is no longer included, to save tokens). It is added to the conversation right away.',
      inputSchema: z.object({ name: z.string().describe('File name, e.g. "rapport.pdf"') }),
      execute: async ({ name }) => {
        const wanted = name.trim().toLowerCase();
        const doc =
          earlier.find((a) => a.name.toLowerCase() === wanted) ?? earlier.find((a) => a.name.toLowerCase().includes(wanted) || wanted.includes(a.name.toLowerCase()));
        if (!doc) return { error: `No earlier document named "${name}". Available: ${earlier.map((a) => a.name).join(', ')}.` };
        if (!pending.includes(doc)) pending.push(doc);
        return { done: true, note: `« ${doc.name} » is now included in the conversation.` };
      },
    }),
  };
  /** Adds the requested documents before the model's next step. */
  const inject = (messages: ModelMessage[]): ModelMessage[] | undefined => {
    if (pending.length === 0) return undefined;
    const docs = pending.splice(0);
    const content = userContent(`Re-attached as you asked: ${docs.map((d) => `« ${d.name} »`).join(', ')}.`, docs);
    return [...messages, { role: 'user', content } as ModelMessage];
  };
  return { tools, inject };
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} Ko`;
  return `${(bytes / 1024 ** 2).toFixed(1)} Mo`;
}
