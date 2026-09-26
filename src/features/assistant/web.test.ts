// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const { extractReadableText, parseBrave, parseDuckDuckGo, relevantExcerpt } = await import('./web');

/**
 * The free search engines are read from their HTML result pages: these fixtures reproduce their
 * markup (as of September 2026). If an engine changes it, these tests say which parser to update
 * (the live check is `cargo test free_search_engines -- --ignored`).
 */

const DDG = `
<div class="result results_links results_links_deep web-result">
  <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fv2.tauri.app%2Frelease%2F&amp;rut=x">Tauri Ecosystem Releases</a></h2>
  <a class="result__snippet" href="#">Latest releases of <b>Tauri</b> 2.</a>
</div>
<div class="result result--ad"><a class="result__a" href="//duckduckgo.com/y.js?ad=1">An ad</a></div>
<div class="result"><h2><a class="result__a" href="https://github.com/tauri-apps/tauri/releases">Releases · tauri-apps/tauri</a></h2>
  <a class="result__snippet">Build smaller, faster apps.</a></div>`;

const BRAVE = `
<div class="snippet svelte-jmfu5f" data-pos="0" data-type="web">
  <div class="result-content"><a href="https://tech-insider.org/fr/tauri-2/" class="l1">
    <div class="site-name-content"><cite class="snippet-url">tech-insider.org</cite></div>
    <div class="title search-snippet-title line-clamp-1" title="Tutoriel Tauri 2 : App Rust en 13 Étapes [2026]">Tutoriel Tauri 2 : App Rust…</div></a>
    <div class="generic-snippet"><div class="content"><span class="t-secondary">il y a 4 jours -</span> Avec <strong>Tauri 2.11</strong>, dernier maillon…</div></div>
  </div>
</div>
<div class="snippet" data-type="web"><a href="https://search.brave.com/ask">Brave's own page</a><div class="title">Ask Brave</div></div>
<div class="snippet" data-type="news"><a href="https://news.example">News widget</a></div>`;

describe('DuckDuckGo results', () => {
  it('unwraps the redirect links, skips the ads', () => {
    const results = parseDuckDuckGo(DDG);
    expect(results.map((r) => r.url)).toEqual(['https://v2.tauri.app/release/', 'https://github.com/tauri-apps/tauri/releases']);
    expect(results[0]).toMatchObject({ title: 'Tauri Ecosystem Releases', domain: 'v2.tauri.app', snippet: 'Latest releases of Tauri 2.' });
  });
});

describe('Brave results', () => {
  it('reads web results with their age, skips Brave pages and widgets', () => {
    const results = parseBrave(BRAVE);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ url: 'https://tech-insider.org/fr/tauri-2/', domain: 'tech-insider.org', title: 'Tutoriel Tauri 2 : App Rust en 13 Étapes [2026]' });
    expect(results[0].snippet.startsWith('il y a 4 jours')).toBe(true);
  });
});

describe('reading pages', () => {
  it('keeps the article, drops menus and scripts', () => {
    const html = `<html><head><title>T</title></head><body><nav>Menu</nav><article><h1>Titre</h1><p>${'Un paragraphe utile. '.repeat(20)}</p></article><footer>Pied</footer><script>x()</script></body></html>`;
    const { title, text } = extractReadableText(html);
    expect(title).toBe('T');
    expect(text).toContain('## Titre');
    expect(text).not.toMatch(/Menu|Pied|x\(\)/);
  });

  it('keeps the passages that answer the question, within the budget', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `Ligne ${i} sans rapport avec le sujet.`);
    lines[150] = 'Le prix du forfait est de 19,99 euros par mois.';
    const { text, truncated } = relevantExcerpt(lines.join('\n'), 'quel est le prix du forfait', 600);
    expect(truncated).toBe(true);
    expect(text.length).toBeLessThanOrEqual(700);
    expect(text).toContain('19,99 euros');
  });
});
