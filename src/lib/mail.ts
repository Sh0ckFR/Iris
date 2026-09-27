import { invoke } from '@tauri-apps/api/core';

/**
 * E-mail, read only (Settings → Proactivity): the unread messages of the inbox, for Iris's
 * suggestions ("Claire vous a écrit…") and the check_email / read_email tools. Rust speaks IMAP
 * (src-tauri/src/mail.rs); the messages' encodings are decoded here.
 */

export interface MailAccount {
  host: string;
  port: number;
  user: string;
  password: string;
}

/** The account saved in the vault (JSON), or null when none is configured. */
export function parseMailAccount(raw: string | undefined): MailAccount | null {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as Partial<MailAccount>;
    if (!data.host || !data.user || !data.password) return null;
    return { host: data.host.trim(), port: Number(data.port) || 993, user: data.user.trim(), password: data.password };
  } catch {
    return null;
  }
}

export interface MailSummary {
  uid: number;
  /** "Claire Martin" (or the address when the name is missing). */
  from: string;
  address: string;
  subject: string;
  /** Unix ms, when the Date header could be read. */
  date: number | null;
}

// ---------------------------------------------------------------- decoding

/** Bytes → text in a charset (latin-1 when the name is unknown, never an exception). */
function decodeBytes(bytes: Uint8Array, charset = 'utf-8'): string {
  try {
    return new TextDecoder(charset.trim().toLowerCase() || 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder('latin1').decode(bytes);
  }
}

/** A "binary string" (one char per byte) back to bytes. */
const binaryToBytes = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);

function base64ToBinary(s: string): string {
  try {
    return atob(s.replace(/[^A-Za-z0-9+/=]/g, ''));
  } catch {
    return '';
  }
}

/** Quoted-printable → binary string. `header`: "_" means a space (RFC 2047 "Q" words). */
function decodeQuotedPrintable(s: string, header = false): string {
  const text = header ? s.replace(/_/g, ' ') : s.replace(/=\r?\n/g, '');
  return text.replace(/=([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/** RFC 2047 encoded words in a header ("=?UTF-8?B?Q2zDqW1lbnQ=?=" → "Clément"). */
export function decodeWords(value: string): string {
  return value
    .replace(/(=\?[^?]+\?[BbQq]\?[^?]*\?=)\s+(?==\?)/g, '$1') // spaces between encoded words vanish
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, charset: string, kind: string, text: string) => {
      const binary = kind.toUpperCase() === 'B' ? base64ToBinary(text) : decodeQuotedPrintable(text, true);
      return decodeBytes(binaryToBytes(binary), charset.split('*')[0]);
    });
}

/** Header block → lower-case name → value (folded lines joined, encoded words decoded). */
export function parseHeaders(block: string): Record<string, string> {
  const headers: Record<string, string> = {};
  const unfolded = block.replace(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    if (!(name in headers)) headers[name] = decodeWords(line.slice(colon + 1).trim());
  }
  return headers;
}

/** "Claire Martin <claire@x.fr>" → name and address. */
export function parseAddress(value: string): { name: string; address: string } {
  const angle = /^(.*?)<([^>]+)>/.exec(value);
  if (angle) {
    const name = angle[1].trim().replace(/^"|"$/g, '').trim();
    return { name: name || angle[2].trim(), address: angle[2].trim() };
  }
  const address = value.trim();
  return { name: address, address };
}

function headerParam(value: string, param: string): string | undefined {
  const match = new RegExp(`${param}\\*?=\\s*(?:"([^"]*)"|([^;\\s]+))`, 'i').exec(value);
  return match ? (match[1] ?? match[2]) : undefined;
}

/** HTML mail → plain text (enough for Iris to read it). */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * The readable text of a MIME entity (a "binary string"): text/plain preferred, else text/html
 * made plain; multiparts searched recursively, attachments skipped.
 */
export function mimeText(entity: string): { plain: string | null; html: string | null } {
  const split = /\r?\n\r?\n/.exec(entity);
  const head = split ? entity.slice(0, split.index) : entity;
  const body = split ? entity.slice(split.index + split[0].length) : '';
  const headers = parseHeaders(head);
  const type = (headers['content-type'] ?? 'text/plain').toLowerCase();
  const disposition = (headers['content-disposition'] ?? '').toLowerCase();
  if (disposition.startsWith('attachment')) return { plain: null, html: null };

  if (type.startsWith('multipart/')) {
    const boundary = headerParam(headers['content-type'] ?? '', 'boundary');
    if (!boundary) return { plain: null, html: null };
    let plain: string | null = null;
    let html: string | null = null;
    for (const part of body.split(`--${boundary}`).slice(1)) {
      if (part.startsWith('--')) break; // closing boundary
      const found = mimeText(part.replace(/^\r?\n/, ''));
      plain ??= found.plain;
      html ??= found.html;
    }
    return { plain, html };
  }
  if (!type.startsWith('text/')) return { plain: null, html: null };

  const encoding = (headers['content-transfer-encoding'] ?? '').toLowerCase();
  const binary = encoding === 'base64' ? base64ToBinary(body) : encoding === 'quoted-printable' ? decodeQuotedPrintable(body) : body;
  const text = decodeBytes(binaryToBytes(binary), headerParam(headers['content-type'] ?? '', 'charset'));
  return type.startsWith('text/html') ? { plain: null, html: text } : { plain: text, html: null };
}

// ---------------------------------------------------------------- the account

let unreadCache: { key: string; at: number; value: MailSummary[] } | null = null;
const UNREAD_TTL_MS = 60_000;

/** The newest unread messages (newest first); cached for a minute. */
export async function unreadMail(account: MailAccount, fresh = false): Promise<MailSummary[]> {
  const key = `${account.user}@${account.host}`;
  if (!fresh && unreadCache?.key === key && Date.now() - unreadCache.at < UNREAD_TTL_MS) return unreadCache.value;
  const raw = await invoke<{ uid: number; headers: string }[]>('mail_unread', { account });
  const value = raw.map(({ uid, headers }) => {
    const h = parseHeaders(headers);
    const from = parseAddress(h.from ?? '');
    const date = h.date ? Date.parse(h.date.replace(/\s*\([^)]*\)\s*$/, '')) : NaN;
    return { uid, from: from.name, address: from.address, subject: h.subject || '(no subject)', date: Number.isFinite(date) ? date : null };
  });
  unreadCache = { key, at: Date.now(), value };
  return value;
}

/** One message, as text for the model (cut to `maxChars`). Reading it does not mark it as read. */
export async function readMail(account: MailAccount, uid: number, maxChars = 6000) {
  const { rawBase64 } = await invoke<{ uid: number; rawBase64: string }>('mail_read', { account, uid });
  const raw = base64ToBinary(rawBase64);
  const split = /\r?\n\r?\n/.exec(raw);
  const headers = parseHeaders(split ? raw.slice(0, split.index) : raw);
  const { plain, html } = mimeText(raw);
  const text = (plain ?? (html ? htmlToText(html) : '')).replace(/\r\n/g, '\n').trim();
  return {
    uid,
    from: headers.from ?? '',
    to: headers.to ?? '',
    subject: headers.subject ?? '',
    date: headers.date ?? '',
    text: text.length > maxChars ? `${text.slice(0, maxChars)}\n… (truncated)` : text,
  };
}
