import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { marked } from 'marked';
import type { VisualBriefing } from '../assistant/tools';
import { Widget } from './widgets/Widget';
import { dashboardStore } from '../../lib/dashboards';
import { uiLocale, useT } from '../../i18n';

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const CODE_EXT: Record<string, string> = {
  python: 'py', py: 'py', javascript: 'js', js: 'js', node: 'js', typescript: 'ts', ts: 'ts', powershell: 'ps1', ps1: 'ps1',
  bash: 'sh', shell: 'sh', sh: 'sh', zsh: 'sh', batch: 'bat', bat: 'bat', cmd: 'bat', sql: 'sql', json: 'json', css: 'css',
  html: 'html', java: 'java', c: 'c', 'c++': 'cpp', cpp: 'cpp', 'c#': 'cs', csharp: 'cs', go: 'go', rust: 'rs', php: 'php',
  ruby: 'rb', yaml: 'yml', yml: 'yml', swift: 'swift', kotlin: 'kt', r: 'r', lua: 'lua', vba: 'bas', dart: 'dart', xml: 'xml',
};

function extensionOf(v: VisualBriefing): string {
  if (v.format === 'code') return CODE_EXT[(v.codeLanguage ?? '').toLowerCase()] ?? 'txt';
  return { html: 'html', svg: 'svg', markdown: 'md', widget: 'json' }[v.format];
}

/** Iris-styled page for documents, SVG and code (web pages bring their own design). */
const DOC_STYLE = `<style>
:root { color-scheme: dark; }
body { margin: 0; padding: 28px 32px; font: 15px/1.65 system-ui, 'Segoe UI', sans-serif; background: #060a04; color: #e6f5d6; }
h1, h2, h3, h4 { color: #fff; line-height: 1.25; margin: 1.3em 0 .5em; } h1 { font-size: 1.8em; margin-top: 0; border-bottom: 1px solid #24380f; padding-bottom: .3em; }
a { color: #76b900; } strong { color: #fff; } hr { border: 0; border-top: 1px solid #24380f; }
table { border-collapse: collapse; width: 100%; margin: 1em 0; } th, td { border: 1px solid #24380f; padding: 8px 10px; text-align: left; vertical-align: top; } th { background: #0f1a08; color: #fff; }
code { background: #0f1a08; padding: 2px 5px; border-radius: 4px; font-family: 'JetBrains Mono', Consolas, monospace; font-size: .9em; }
pre { background: #0f1a08; padding: 14px; border-radius: 8px; overflow: auto; } pre code { padding: 0; background: none; }
blockquote { border-left: 3px solid #76b900; margin: 1em 0; padding-left: 14px; color: #b4cf9a; } img { max-width: 100%; }
</style>`;

/** Complete HTML document of a visual: used for the live preview and for "open in browser". */
export function visualDocument(v: VisualBriefing): string {
  const head = (extra = '') => `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(v.heading)}</title>${extra}</head>`;
  switch (v.format) {
    case 'html':
      return v.content;
    case 'svg':
      return `${head('<style>html,body{margin:0;height:100%;background:#060a04}body{display:grid;place-items:center}svg{width:min(92vw,900px);height:auto;max-height:92vh}</style>')}<body>${v.content}</body></html>`;
    case 'markdown':
      return `${head(DOC_STYLE)}<body>${marked.parse(v.content, { async: false }) as string}</body></html>`;
    case 'code':
    case 'widget': // a widget's data (the widget itself is rendered by the HUD)
      return `${head(DOC_STYLE)}<body><pre><code>${escapeHtml(v.content)}</code></pre></body></html>`;
  }
}

/** While streaming, the preview reloads at most this often (each reload re-runs the page). */
const PREVIEW_INTERVAL_MS = 1200;

export function VisualView({ visual }: { visual: VisualBriefing }) {
  const tr = useT();
  const t = tr.visual;
  const streaming = visual.status === 'streaming';
  const isWidget = visual.format === 'widget';
  const [tab, setTab] = useState<'preview' | 'code'>(visual.format === 'code' ? 'code' : 'preview');
  const [doc, setDoc] = useState(() => visualDocument(visual));
  const lastRender = useRef(0);
  const [saved, setSaved] = useState<Record<string, string>>({});
  const [flash, setFlash] = useState<string | null>(null);
  const codeRef = useRef<HTMLPreElement>(null);

  // Live preview, throttled while the content streams in.
  useEffect(() => {
    const next = visualDocument(visual);
    if (!streaming) {
      setDoc(next);
      return;
    }
    const wait = Math.max(0, PREVIEW_INTERVAL_MS - (Date.now() - lastRender.current));
    const timer = window.setTimeout(() => {
      lastRender.current = Date.now();
      setDoc(next);
    }, wait);
    return () => window.clearTimeout(timer);
  }, [visual, streaming]);

  // Follow the code as it is written.
  useEffect(() => {
    if (streaming && codeRef.current) codeRef.current.scrollTop = codeRef.current.scrollHeight;
  }, [visual.content, streaming]);

  useEffect(() => {
    if (!flash) return;
    const timer = window.setTimeout(() => setFlash(null), 2500);
    return () => window.clearTimeout(timer);
  }, [flash]);

  /** Saves once per extension (Save then Open reuse the same file). */
  const saveAs = async (ext: string, content: string) => {
    if (saved[ext]) return saved[ext];
    const path = await invoke<string>('save_visual', { name: visual.heading, extension: ext, content });
    setSaved((s) => ({ ...s, [ext]: path }));
    return path;
  };

  const run = (action: () => Promise<void>) => () => {
    action().catch((e) => setFlash(tr.common.failed(e instanceof Error ? e.message : String(e))));
  };

  const copy = run(async () => {
    await navigator.clipboard.writeText(visual.content);
    setFlash(t.copied);
  });
  const save = run(async () => {
    const path = await saveAs(extensionOf(visual), visual.content);
    setFlash(t.saved(path));
  });
  const openInBrowser = run(async () => {
    // Documents and SVG open as a styled page (the same one as the preview).
    const path = await saveAs('html', visualDocument(visual));
    await invoke('os_open_path', { path });
  });
  const showFolder = run(async () => {
    const path = Object.values(saved)[0] ?? (await saveAs(extensionOf(visual), visual.content));
    await invoke('os_open_path', { path: path.replace(/[\\/][^\\/]+$/, '') });
  });

  return (
    <div className="vis">
      <div className="vis-bar">
        {visual.format !== 'code' && (
          <div className="vis-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={tab === 'preview'} className={tab === 'preview' ? 'on' : ''} onClick={() => setTab('preview')}>
              {t.preview}
            </button>
            <button type="button" role="tab" aria-selected={tab === 'code'} className={tab === 'code' ? 'on' : ''} onClick={() => setTab('code')}>
              {isWidget ? t.data : t.code}
            </button>
          </div>
        )}
        {streaming && (
          <span className="vis-status">
            <span className="hud-spinner" aria-hidden />
            {t.building} {visual.content.length.toLocaleString(uiLocale())} {t.chars}
          </span>
        )}
        <span className="vis-spacer" />
        {isWidget && visual.widget && (
          <button
            type="button"
            className="set-btn set-btn--ghost"
            onClick={() => {
              const d = dashboardStore.pin(visual.widget!);
              setFlash(t.pinned(d.name));
            }}
            title={t.pinTitle}
          >
            {t.pin}
          </button>
        )}
        <button type="button" className="set-btn set-btn--ghost" onClick={copy} disabled={!visual.content}>
          {t.copy}
        </button>
        <button type="button" className="set-btn set-btn--ghost" onClick={save} disabled={streaming || !visual.content}>
          {tr.common.save}
        </button>
        {visual.format !== 'code' && !isWidget && (
          <button type="button" className="set-btn set-btn--ghost" onClick={openInBrowser} disabled={streaming || !visual.content}>
            {t.openInBrowser}
          </button>
        )}
        {Object.keys(saved).length > 0 && (
          <button type="button" className="set-btn set-btn--ghost" onClick={showFolder}>
            {t.folder}
          </button>
        )}
      </div>

      {visual.status === 'error' && <p className="vis-error">{visual.error}</p>}
      {flash && <p className="vis-flash">{flash}</p>}

      {tab === 'preview' && isWidget && visual.widget ? (
        <div className="vis-widget">
          <Widget key={visual.id} spec={visual.widget} />
        </div>
      ) : tab === 'preview' && visual.format !== 'code' ? (
        // Sandboxed (no same-origin): the page's scripts run but can't reach Iris or its data.
        <iframe
          className={`vis-frame vis-frame--${visual.format}`}
          title={visual.heading}
          sandbox="allow-scripts allow-forms allow-modals"
          srcDoc={doc}
        />
      ) : (
        <pre ref={codeRef} className="vis-code">
          <code>{visual.content || t.waiting}</code>
        </pre>
      )}
    </div>
  );
}
