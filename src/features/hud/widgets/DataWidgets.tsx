import { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import type { WidgetSpec } from '../../assistant/widgetTools';
import { categoryColors, withUnit } from './palette';
import { ItemLink } from './common';
import { LiveBadge, useLiveItems } from './live';
import { uiLocale, useT } from '../../../i18n';

/** "1 234,5 €", "12%", "-3.2" → number; null for text. */
function numeric(cell: string): number | null {
  const clean = cell.replace(/[\s  ]/g, '').replace(/[€$£¥%°]|[a-zA-Z]+$/g, '');
  if (!/^[-+]?[\d.,]+$/.test(clean)) return null;
  const normalized = /,\d{1,2}$/.test(clean) || (clean.includes(',') && !clean.includes('.')) ? clean.replace(/\./g, '').replace(',', '.') : clean.replace(/,/g, '');
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------- table

export function TableWidget({ spec }: { spec: WidgetSpec }) {
  // Rows, or the items as a two/three-column table.
  const t = useT().table;
  const columns = spec.columns?.length ? spec.columns : [t.name, ...(spec.items.some((i) => i.value !== undefined) ? [t.value] : []), t.details];
  const rows = useMemo(
    () =>
      spec.rows?.length
        ? spec.rows
        : spec.items.map((i) => [i.label, ...(columns.length === 3 ? [i.value !== undefined ? withUnit(i.value, i.unit ?? spec.unit) : ''] : []), i.detail ?? '']),
    [spec, columns.length],
  );
  const [sort, setSort] = useState<{ col: number; dir: 1 | -1 } | null>(null);
  const numericCols = columns.map((_, c) => rows.length > 0 && rows.every((r) => !r[c] || numeric(r[c]) !== null));
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const { col, dir } = sort;
    return [...rows].sort((a, b) => {
      const na = numeric(a[col] ?? '');
      const nb = numeric(b[col] ?? '');
      if (na !== null && nb !== null) return (na - nb) * dir;
      return (a[col] ?? '').localeCompare(b[col] ?? '', uiLocale(), { numeric: true }) * dir;
    });
  }, [rows, sort]);

  return (
    <div className="wg-table-wrap">
      <table className="wg-table">
        <thead>
          <tr>
            {columns.map((c, i) => (
              <th
                key={i}
                className={numericCols[i] ? 'is-num' : ''}
                onClick={() => setSort((s) => (s?.col === i ? (s.dir === 1 ? { col: i, dir: -1 } : null) : { col: i, dir: 1 }))}
                aria-sort={sort?.col === i ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}
              >
                {c}
                <span className="wg-sort">{sort?.col === i ? (sort.dir === 1 ? '▲' : '▼') : ''}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r, i) => (
            <tr key={i}>
              {columns.map((_, c) => (
                <td key={c} className={numericCols[c] ? 'is-num' : ''}>
                  {r[c] ?? ''}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="brief-meta">{t.sortHint}</p>
    </div>
  );
}

// ---------------------------------------------------------------- key figures

export function StatsWidget({ spec }: { spec: WidgetSpec }) {
  const { items, updatedAt, live } = useLiveItems(spec.items);
  return (
    <div className="wg-stats">
      {live && (
        <div className="wg-live-row">
          <LiveBadge updatedAt={updatedAt} />
        </div>
      )}
      {items.map((i, index) => {
        const up = (i.change ?? 0) >= 0;
        return (
          <motion.div key={`${i.label}-${index}`} className="wg-stat" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * 0.05 }}>
            <span className="wg-kicker">{i.label}</span>
            <span className="wg-stat-value">
              {i.value !== undefined ? withUnit(i.value, i.unit ?? spec.unit) : '—'}
            </span>
            {i.change !== undefined && (
              // Sign + arrow + colour: never colour alone.
              <span className={`wg-stat-change wg-stat-change--${up ? 'up' : 'down'}`}>
                {up ? '▲ +' : '▼ −'}
                {Math.abs(i.change).toLocaleString(uiLocale(), { maximumFractionDigits: 2 })} %
              </span>
            )}
            {i.detail && <span className="brief-meta">{i.detail}</span>}
          </motion.div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- timeline

export function TimelineWidget({ spec }: { spec: WidgetSpec }) {
  const { colorOf } = useMemo(() => categoryColors(spec.items.map((i) => i.category)), [spec.items]);
  return (
    <ol className="wg-timeline">
      {spec.items.map((i, index) => (
        <motion.li
          key={`${i.label}-${index}`}
          style={{ ['--wg-color' as string]: colorOf(i.category) }}
          initial={{ opacity: 0, x: -8 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: index * 0.05 }}
        >
          <span className="wg-timeline-date">{i.date ?? ''}</span>
          <div className="wg-timeline-body">
            {i.category && <span className="wg-tag">{i.category}</span>}
            <b>{i.label}</b>
            {i.detail && <p>{i.detail}</p>}
            <ItemLink url={i.url} />
          </div>
        </motion.li>
      ))}
    </ol>
  );
}

// ---------------------------------------------------------------- cards

export function CardsWidget({ spec }: { spec: WidgetSpec }) {
  const { colorOf } = useMemo(() => categoryColors(spec.items.map((i) => i.category)), [spec.items]);
  const { items, updatedAt, live } = useLiveItems(spec.items);
  return (
    <div className="wg-cards">
      {live && (
        <div className="wg-live-row">
          <LiveBadge updatedAt={updatedAt} />
        </div>
      )}
      {items.map((i, index) => (
        <motion.article
          key={`${i.label}-${index}`}
          className="wg-card"
          style={{ ['--wg-color' as string]: colorOf(i.category) }}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: index * 0.04 }}
        >
          <div className="wg-card-head">
            {i.category && <span className="wg-tag">{i.category}</span>}
            {i.date && <span className="brief-meta">{i.date}</span>}
          </div>
          <b>{i.label}</b>
          {i.value !== undefined && <span className="wg-card-value">{withUnit(i.value, i.unit ?? spec.unit)}</span>}
          {i.detail && <p>{i.detail}</p>}
          <ItemLink url={i.url} />
        </motion.article>
      ))}
    </div>
  );
}
