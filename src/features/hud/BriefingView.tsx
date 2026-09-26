import { AnimatePresence, motion } from 'framer-motion';
import { invoke } from '@tauri-apps/api/core';
import type { ReactNode } from 'react';
import { describeWeather, type Briefing, type NewsItem, type StockQuote } from '../assistant/tools';
import { ExternalLinkIcon } from './icons';
import { VisualView } from './VisualView';
import { HoloGlobe } from './HoloGlobe';
import { HoloChart } from './HoloChart';
import { LiveBadge, useLiveForecast, useLiveQuote } from './widgets/live';
import { t, uiLanguage, uiLocale as locale, useT } from '../../i18n';

/** Opens a web source in the default browser (an <a href> would navigate the Iris window itself). */
function openLink(url: string) {
  invoke('os_open_url', { url }).catch((e) => console.warn('[iris] could not open link', url, e));
}

/** One list row; clickable (opens its source) when it has a URL. */
function Row({ url, index, children }: { url?: string; index: number; children: ReactNode }) {
  const body = (
    <>
      <span className="brief-news-index">{String(index + 1).padStart(2, '0')}</span>
      <div className="brief-news-body">{children}</div>
    </>
  );
  if (!url) return <div className="brief-news-row">{body}</div>;
  return (
    <button
      type="button"
      className="brief-news-row brief-news-row--link"
      onClick={() => openLink(url)}
      title={t().briefing.openInBrowser(url)}
    >
      {body}
      <ExternalLinkIcon className="brief-news-arrow" width={14} height={14} />
    </button>
  );
}

/** "Read on …" button under a card. */
function SourceLink({ url, label }: { url?: string; label: string }) {
  if (!url) return null;
  return (
    <button type="button" className="brief-source" onClick={() => openLink(url)} title={url}>
      <ExternalLinkIcon width={13} height={13} />
      {label}
    </button>
  );
}

function timeAgo(iso: string | null): string {
  if (!iso) return '';
  const rtf = new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' });
  const minutes = Math.round((new Date(iso).getTime() - Date.now()) / 60_000);
  if (Math.abs(minutes) < 60) return rtf.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 48) return rtf.format(hours, 'hour');
  return rtf.format(Math.round(hours / 24), 'day');
}

function News({ items }: { items: NewsItem[] }) {
  return (
    <ol className="brief-news">
      {items.map((item, i) => (
        <motion.li
          key={`${item.title}-${i}`}
          initial={{ opacity: 0, x: 12 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: i * 0.05, duration: 0.3 }}
        >
          <Row url={item.url} index={i}>
            <p className="brief-news-title">{item.title}</p>
            <p className="brief-meta">
              {item.source}
              {item.publishedAt && ` · ${timeAgo(item.publishedAt)}`}
            </p>
          </Row>
        </motion.li>
      ))}
    </ol>
  );
}

function Weather({ briefing: initial }: { briefing: Extract<Briefing, { kind: 'weather' }> }) {
  // Refreshed every 10 minutes while it is on screen (Open-Meteo, no AI).
  const { data: briefing, updatedAt } = useLiveForecast(initial, initial.coords);
  const m = useT().briefing;
  const lang = uiLanguage();
  const now = describeWeather(briefing.current.code, lang);
  const day = new Intl.DateTimeFormat(locale(), { weekday: 'short' });
  return (
    <div className="brief-weather">
      <p className="brief-meta brief-live-head">
        {briefing.place}
        {briefing.coords && <LiveBadge updatedAt={updatedAt} />}
      </p>
      {briefing.coords && <HoloGlobe points={[briefing.coords]} size={170} />}
      <div className="brief-weather-now">
        <span className="brief-weather-icon" aria-hidden>{now.icon}</span>
        <span className="brief-weather-temp">{briefing.current.temperature}°</span>
        <div>
          <p>{now.label}</p>
          <p className="brief-meta">
            {m.feelsLike} {briefing.current.feelsLike}° · {briefing.current.wind} km/h
          </p>
        </div>
      </div>
      <div className="brief-weather-days">
        {briefing.days.map((d) => {
          const w = describeWeather(d.code, lang);
          return (
            <div key={d.date} className="brief-weather-day" title={w.label}>
              <span className="brief-meta">{day.format(new Date(`${d.date}T12:00:00`))}</span>
              <span aria-hidden>{w.icon}</span>
              <span>
                {d.max}° <span className="brief-meta">{d.min}°</span>
              </span>
            </div>
          );
        })}
      </div>
      <SourceLink url={briefing.sourceUrl} label={m.weatherSource} />
    </div>
  );
}

function Wiki({ briefing }: { briefing: Extract<Briefing, { kind: 'wiki' }> }) {
  return (
    <article className="brief-wiki">
      {briefing.coords && <HoloGlobe points={[briefing.coords]} size={160} />}
      {briefing.thumbnail && <img src={briefing.thumbnail} alt="" />}
      <h3>{briefing.title}</h3>
      {briefing.description && <p className="brief-meta">{briefing.description}</p>}
      <p className="brief-wiki-extract">{briefing.extract}</p>
      <SourceLink url={briefing.url} label={t().briefing.readWikipedia} />
    </article>
  );
}

function Stock({ quote: initial }: { quote: StockQuote }) {
  // Follows the market every minute while it is on screen (Yahoo Finance, no AI).
  const { quote, updatedAt } = useLiveQuote(initial);
  const money = (v: number) => v.toLocaleString(locale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const up = (quote.change ?? 0) >= 0;
  const m = useT().briefing;
  return (
    <div className="brief-stock">
      <p className="brief-stock-name">{quote.name}</p>
      <p className="brief-meta brief-live-head">
        {quote.symbol} · {quote.exchange}
        <LiveBadge updatedAt={updatedAt} />
      </p>
      <div className="brief-stock-price">
        <span className="brief-stock-value">
          {money(quote.price)} <small>{quote.currency}</small>
        </span>
        {quote.change !== null && quote.changePercent !== null && (
          <span className={`brief-stock-change brief-stock-change--${up ? 'up' : 'down'}`}>
            {up ? '▲' : '▼'} {money(Math.abs(quote.change))} ({up ? '+' : '−'}
            {Math.abs(quote.changePercent).toFixed(2)} %)
          </span>
        )}
      </div>
      <HoloChart quote={quote} />
      <div className="brief-stock-grid">
        {quote.dayLow !== null && quote.dayHigh !== null && (
          <span>
            {m.dayRange} <b>{money(quote.dayLow)} – {money(quote.dayHigh)}</b>
          </span>
        )}
        {quote.previousClose !== null && (
          <span>
            {m.prevClose} <b>{money(quote.previousClose)}</b>
          </span>
        )}
      </div>
      <p className="brief-meta">
        {m.lastTrade} {timeAgo(quote.time)}
      </p>
      <SourceLink url={quote.url} label={m.viewQuote} />
    </div>
  );
}

function Web({ briefing }: { briefing: Extract<Briefing, { kind: 'web' }> }) {
  return (
    <div className="brief-web">
      {briefing.answer && <p className="brief-web-answer">{briefing.answer}</p>}
      <ol className="brief-news">
        {briefing.results.map((r, i) => (
          <li key={`${r.url}-${i}`}>
            <Row url={r.url} index={i}>
              <p className="brief-news-title">{r.title}</p>
              <p className="brief-meta">{r.domain}</p>
              <p className="brief-web-snippet">{r.snippet.length > 220 ? `${r.snippet.slice(0, 220)}…` : r.snippet}</p>
            </Row>
          </li>
        ))}
      </ol>
      {briefing.engine && <p className="brief-meta">{t().briefing.results}{briefing.engine}</p>}
    </div>
  );
}

function Page({ briefing }: { briefing: Extract<Briefing, { kind: 'page' }> }) {
  return (
    <article className="brief-wiki">
      <h3>{briefing.title}</h3>
      <p className="brief-meta">{briefing.domain}</p>
      <p className="brief-wiki-extract brief-page-text">{briefing.excerpt}</p>
      <SourceLink url={briefing.url} label={t().briefing.openPage} />
    </article>
  );
}

function formatSize(bytes: number): string {
  const [unit, ...units] = t().common.byteUnits;
  if (bytes < 1024) return `${bytes} ${unit}`;
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

function Files({ briefing }: { briefing: Extract<Briefing, { kind: 'files' }> }) {
  const date = new Intl.DateTimeFormat(locale(), { dateStyle: 'short' });
  return (
    <div className="brief-files">
      <p className="brief-meta mono">{briefing.path}</p>
      {briefing.entries.length === 0 && <p className="brief-meta">{t().briefing.empty}</p>}
      <ul>
        {briefing.entries.map((e) => (
          <li key={e.name}>
            <span aria-hidden>{e.isDir ? '📁' : '📄'}</span>
            <span className="brief-files-name">{e.name}</span>
            <span className="brief-meta">{e.isDir ? '' : formatSize(e.size)}</span>
            <span className="brief-meta">{e.modified ? date.format(new Date(e.modified)) : ''}</span>
          </li>
        ))}
      </ul>
      {briefing.truncated && <p className="brief-meta">…</p>}
    </div>
  );
}

function Command({ briefing }: { briefing: Extract<Briefing, { kind: 'command' }> }) {
  const ok = !briefing.timedOut && briefing.exitCode === 0;
  return (
    <div className="brief-cmd">
      <pre className="brief-cmd-line">&gt; {briefing.command}</pre>
      <p className={`brief-meta brief-cmd-status--${ok ? 'ok' : 'fail'}`}>
        {briefing.timedOut ? t().briefing.timeout : t().briefing.exitCode(String(briefing.exitCode ?? '?'))}
      </p>
      {briefing.stdout && <pre className="brief-cmd-out">{briefing.stdout}</pre>}
      {briefing.stderr && <pre className="brief-cmd-out brief-cmd-err">{briefing.stderr}</pre>}
    </div>
  );
}

function GeneratedImage({ briefing }: { briefing: Extract<Briefing, { kind: 'image' }> }) {
  const m = useT();
  const folder = briefing.path.replace(/[\\/][^\\/]+$/, '');
  return (
    <figure className="brief-image">
      <img src={briefing.dataUrl} alt={briefing.prompt} />
      <figcaption>
        <p className="brief-meta">{briefing.prompt}</p>
        {/* Screenshots are not saved: no path, no file actions. */}
        {briefing.path && <p className="brief-meta mono">{briefing.path}</p>}
        {briefing.path && (
          <div className="brief-image-actions">
            <button type="button" className="set-btn set-btn--ghost" onClick={() => void invoke('os_open_path', { path: briefing.path })}>
              {m.common.open}
            </button>
            <button type="button" className="set-btn set-btn--ghost" onClick={() => void invoke('os_open_path', { path: folder })}>
              {m.briefing.showInFolder}
            </button>
          </div>
        )}
      </figcaption>
    </figure>
  );
}

/** Renders a live-data briefing inside the HUD; its sources open in the browser only when clicked. */
export function BriefingView({ briefing }: { briefing: Briefing }) {
  useT(); // re-renders the cards when the interface language changes
  return (
    <div className="brief">
      <AnimatePresence mode="wait">
        <motion.div
          key={briefing.id}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.25 }}
        >
          {briefing.kind === 'news' && (
            <>
              {briefing.place && <HoloGlobe points={[briefing.place]} size={150} />}
              <News items={briefing.items} />
            </>
          )}
          {briefing.kind === 'weather' && <Weather briefing={briefing} />}
          {briefing.kind === 'wiki' && <Wiki briefing={briefing} />}
          {briefing.kind === 'stock' && <Stock quote={briefing.quote} />}
          {briefing.kind === 'web' && <Web briefing={briefing} />}
          {briefing.kind === 'page' && <Page briefing={briefing} />}
          {briefing.kind === 'files' && <Files briefing={briefing} />}
          {briefing.kind === 'command' && <Command briefing={briefing} />}
          {briefing.kind === 'image' && <GeneratedImage briefing={briefing} />}
          {briefing.kind === 'visual' && <VisualView visual={briefing} />}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
