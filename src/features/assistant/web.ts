import { invoke } from '@tauri-apps/api/core';
import type { WebResult } from './tools';

/**
 * Key-free, quota-free web access: DuckDuckGo and Brave searches, and reading any public page.
 * Pages are downloaded by Rust (`web_get`, no allowlist, read-only GET) and parsed here with the
 * webview's own HTML parser.
 */

interface WebPage {
  status: number;
  contentType: string;
  /** Address after redirects. */
  url: string;
  body: string;
}

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** "example.com/fr" → "https://example.com/fr". */
export function normalizeUrl(raw: string): string {
  const url = raw.trim();
  return /^https?:\/\//i.test(url) ? url : `https://${url.replace(/^\/+/, '')}`;
}

const webGet = (url: string, lang: string) => invoke<WebPage>('web_get', { url, language: lang });

const collapse = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------- search

/** DuckDuckGo region per language (results in the user's language first). */
const DDG_REGIONS: Record<string, string> = { fr: 'fr-fr', de: 'de-de', es: 'es-es', it: 'it-it', nl: 'nl-nl', pt: 'pt-pt' };

/** DuckDuckGo result links go through a redirect: //duckduckgo.com/l/?uddg=<target>. */
function unwrapResultLink(href: string): string | null {
  try {
    const url = new URL(href, 'https://duckduckgo.com');
    const target = url.searchParams.get('uddg');
    if (target) return target;
    return url.hostname.endsWith('duckduckgo.com') ? null : url.href;
  } catch {
    return null;
  }
}

/** Parses the result list of html.duckduckgo.com (ads skipped). Exported for tests. */
export function parseDuckDuckGo(html: string): WebResult[] {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const seen = new Set<string>();
  const results: WebResult[] = [];
  for (const el of Array.from(doc.querySelectorAll('.result'))) {
    if (el.classList.contains('result--ad')) continue;
    const link = el.querySelector('a.result__a');
    const url = link ? unwrapResultLink(link.getAttribute('href') ?? '') : null;
    if (!link || !url || seen.has(url)) continue;
    seen.add(url);
    results.push({
      title: collapse(link.textContent),
      url,
      domain: domainOf(url),
      snippet: collapse(el.querySelector('.result__snippet')?.textContent),
    });
  }
  return results;
}

/** How recent results must be ("latest", news of the day…); omitted = any date. */
export type Recency = 'day' | 'week' | 'month' | 'year';

const DDG_RECENCY: Record<Recency, string> = { day: 'd', week: 'w', month: 'm', year: 'y' };
const BRAVE_RECENCY: Record<Recency, string> = { day: 'pd', week: 'pw', month: 'pm', year: 'py' };

/** Unlimited web search (no key, no quota). */
export async function searchDuckDuckGo(query: string, lang: string, max = 8, recency?: Recency): Promise<WebResult[]> {
  const region = DDG_REGIONS[lang] ?? 'wt-wt';
  const df = recency ? `&df=${DDG_RECENCY[recency]}` : '';
  const page = await webGet(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=${region}${df}`, lang);
  if (page.status >= 400) throw new Error(`DuckDuckGo answered HTTP ${page.status}.`);
  const results = parseDuckDuckGo(page.body);
  if (results.length === 0 && /anomaly|challenge|captcha/i.test(page.body) && !/no-results/.test(page.body)) {
    throw new Error('DuckDuckGo is temporarily limiting automated searches; try again in a minute.');
  }
  return results.slice(0, max);
}

/**
 * Parses Brave Search's server-rendered results (ads and widgets skipped). Snippets start with the
 * page's age ("il y a 4 jours - …"), which tells the model how fresh a result is. Exported for tests.
 */
export function parseBrave(html: string): WebResult[] {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const seen = new Set<string>();
  const results: WebResult[] = [];
  for (const el of Array.from(doc.querySelectorAll('.snippet[data-type="web"]'))) {
    const url = el.querySelector('a[href^="http"]')?.getAttribute('href');
    if (!url || seen.has(url) || domainOf(url).endsWith('brave.com')) continue;
    const titleEl = el.querySelector('.search-snippet-title, .title');
    const title = collapse(titleEl?.getAttribute('title') || titleEl?.textContent);
    if (!title) continue;
    seen.add(url);
    results.push({
      title,
      url,
      domain: domainOf(url),
      snippet: collapse(el.querySelector('.generic-snippet .content, .snippet-description, .content')?.textContent),
    });
  }
  return results;
}

/**
 * Second free engine, used when DuckDuckGo is limiting automated searches (no key, no quota;
 * Brave has its own index, so results also differ usefully).
 */
export async function searchBrave(query: string, lang: string, max = 8, recency?: Recency): Promise<WebResult[]> {
  const tf = recency ? `&tf=${BRAVE_RECENCY[recency]}` : '';
  const page = await webGet(`https://search.brave.com/search?q=${encodeURIComponent(query)}&source=web${tf}`, lang);
  if (page.status >= 400) throw new Error(`Brave Search answered HTTP ${page.status}.`);
  const results = parseBrave(page.body);
  if (results.length === 0 && /captcha|pow-captcha|are you a robot/i.test(page.body) && !/no results|aucun résultat/i.test(page.body)) {
    throw new Error('Brave Search is temporarily limiting automated searches.');
  }
  return results.slice(0, max);
}

// ---------------------------------------------------------------- reading pages

const NOISE = 'script, style, noscript, template, svg, canvas, iframe, form, nav, header, footer, aside, button, dialog, [hidden], [aria-hidden="true"], [role="navigation"], [role="banner"], [role="contentinfo"], .cookie, .advert, .ad';
const BLOCKS = 'h1, h2, h3, h4, p, li, pre, blockquote, td, th, dt, dd, figcaption';

/** Main readable text of an HTML page (menus, scripts, footers removed). Exported for tests. */
export function extractReadableText(html: string): { title: string; text: string } {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const title =
    collapse(doc.querySelector('meta[property="og:title"]')?.getAttribute('content')) ||
    collapse(doc.querySelector('title')?.textContent) ||
    collapse(doc.querySelector('h1')?.textContent);
  doc.querySelectorAll(NOISE).forEach((el) => el.remove());

  const body = doc.body;
  if (!body) return { title, text: '' };
  // The biggest <article>/<main> holds the content, unless it is just a small card of the page.
  const bodyLength = collapse(body.textContent).length;
  const main = Array.from(doc.querySelectorAll('article, main, [role="main"]'))
    .map((el) => ({ el, length: collapse(el.textContent).length }))
    .sort((a, b) => b.length - a.length)[0];
  const root = main && main.length > bodyLength * 0.3 ? main.el : body;

  const lines: string[] = [];
  for (const el of Array.from(root.querySelectorAll(BLOCKS))) {
    if (el.querySelector(BLOCKS)) continue; // its inner blocks are listed on their own
    const text = collapse(el.textContent);
    if (text.length < 2 || text === lines[lines.length - 1]) continue;
    lines.push(/^H[1-4]$/.test(el.tagName) ? `## ${text}` : el.tagName === 'LI' ? `- ${text}` : text);
  }
  const text = lines.join('\n');
  // Pages built from bare <div>s: fall back to all the text.
  return { title, text: text.length > 200 ? text : collapse(root.textContent) };
}

/** Words too common to tell passages apart (French + English). */
const STOPWORDS = new Set(
  (
    'the and for are was were with that this from what which who how when where why does have has you your their there about into ' +
    'les des une est sont avec pour dans par sur que qui quoi quel quelle quels quelles comment pourquoi quand plus pas mais ' +
    'aux ces cet cette son ses leur leurs nous vous ils elles été être avoir fait faire tout tous'
  ).split(' '),
);

/** Significant words of a text (lower case, no accents, no stop words): for keyword matching. */
export const terms = (text: string) =>
  text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));

/**
 * The passages of a page that matter for a question, within `max` characters, in page order.
 * Keeps the start of the page (title, summary) and the lines sharing the most words with the
 * question, plus their neighbours for context. Without a question: the start of the page.
 * Exported for tests.
 */
export function relevantExcerpt(text: string, question: string | undefined, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const wanted = new Set(terms(question ?? ''));
  const lines = text.split('\n').filter((l) => l.trim());
  if (wanted.size === 0) return { text: text.slice(0, max), truncated: true };

  // Score: how many distinct question words the line contains.
  const scores = lines.map((line) => {
    const words = new Set(terms(line));
    let score = 0;
    wanted.forEach((w) => {
      if (words.has(w)) score += 1;
    });
    return score;
  });
  const keep = new Set<number>([0, 1, 2].filter((i) => i < lines.length));
  let size = [...keep].reduce((n, i) => n + lines[i].length + 1, 0);
  const ranked = lines.map((_, i) => i).filter((i) => scores[i] > 0).sort((a, b) => scores[b] - scores[a] || a - b);
  for (const i of ranked) {
    for (const j of [i, i - 1, i + 1]) {
      if (j < 0 || j >= lines.length || keep.has(j)) continue;
      if (size + lines[j].length + 1 > max) continue;
      keep.add(j);
      size += lines[j].length + 1;
    }
    if (size >= max * 0.95) break;
  }
  // Room left: the start of the page, for context (the question may use other words).
  for (let i = 0; i < lines.length && size < max; i++) {
    if (keep.has(i) || size + lines[i].length + 1 > max) continue;
    keep.add(i);
    size += lines[i].length + 1;
  }
  // Gaps between kept passages are marked so the model knows text was skipped.
  const out: string[] = [];
  let previous = -1;
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (previous >= 0 && i > previous + 1) out.push('[…]');
    out.push(lines[i]);
    previous = i;
  }
  return { text: out.join('\n'), truncated: true };
}

export interface ReadPage {
  title: string;
  url: string;
  domain: string;
  text: string;
}

export async function readWebPage(rawUrl: string, lang: string): Promise<ReadPage> {
  const page = await webGet(normalizeUrl(rawUrl), lang);
  if (page.status >= 400) throw new Error(`The page answered HTTP ${page.status}.`);
  const type = page.contentType.toLowerCase();
  const domain = domainOf(page.url);
  if (type.includes('pdf')) throw new Error('This link is a PDF: download it and attach it to the conversation so I can read it.');
  if (type.includes('html') || type === '' || /^\s*</.test(page.body)) {
    const { title, text } = extractReadableText(page.body);
    if (!text) throw new Error('This page has no readable text (it may need JavaScript or a login).');
    return { title: title || domain, url: page.url, domain, text };
  }
  if (/^text\/|json|xml/.test(type)) return { title: domain, url: page.url, domain, text: page.body.trim() };
  throw new Error(`This link is not a web page (${page.contentType}).`);
}
