import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { motion } from 'framer-motion';
import type { ChartType, WidgetSpec } from '../../assistant/widgetTools';
import { CATEGORICAL, OTHER, SINGLE, formatNumber, withUnit } from './palette';
import { t, uiLocale, useT } from '../../../i18n';

/**
 * Line, area, bar and donut charts drawn from the widget data, in SVG sized to the panel (text is
 * never stretched). Thin marks, recessive grid, one axis; a crosshair tooltip on lines, a
 * tooltip per bar or slice; a legend for several series (≤ 4 are also labelled at the line end);
 * a table view of the same data.
 */

const SURFACE = '#060a04';


interface Series {
  name: string;
  values: number[];
  color: string;
}

function normalize(spec: WidgetSpec): { labels: string[]; series: Series[]; type: ChartType } {
  let labels: string[];
  let raw: { name: string; values: number[] }[];
  if (spec.series?.length) {
    const n = Math.max(...spec.series.map((s) => s.values.length));
    labels = (spec.labels ?? []).slice(0, n);
    while (labels.length < n) labels.push(String(labels.length + 1));
    raw = spec.series.map((s) => ({ name: s.name, values: labels.map((_, i) => s.values[i] ?? NaN) }));
  } else {
    labels = spec.items.map((i) => i.label);
    raw = [{ name: spec.title, values: spec.items.map((i) => i.value ?? NaN) }];
  }
  const series = raw.map((s, i) => ({ ...s, color: raw.length === 1 ? SINGLE : (CATEGORICAL[i] ?? OTHER) }));
  // Many points (dates, months) read as a line; a few categories as bars.
  const type = spec.chartType ?? (labels.length > 8 ? 'line' : 'bar');
  return { labels, series, type };
}

/** Round axis steps: 0, 250, 500… */
function niceTicks(min: number, max: number, count = 5): number[] {
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const ticks: number[] = [];
  for (let v = Math.floor(min / step) * step; v <= max + step * 0.001; v += step) ticks.push(Number(v.toPrecision(12)));
  if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
  return ticks;
}

/** A bar whose data end (away from zero) has 4px rounded corners. */
function barPath(x: number, y0: number, y1: number, w: number, horizontal = false): string {
  if (horizontal) {
    // x axis = value: y0 → y1 are x positions, x/w the band.
    const [a, b] = [y0, y1];
    const r = Math.min(4, Math.abs(b - a) / 2, w / 2);
    const dir = b >= a ? 1 : -1;
    return `M${a},${x}H${b - dir * r}Q${b},${x} ${b},${x + r}V${x + w - r}Q${b},${x + w} ${b - dir * r},${x + w}H${a}Z`;
  }
  const r = Math.min(4, Math.abs(y1 - y0) / 2, w / 2);
  const dir = y1 <= y0 ? 1 : -1; // up for positive values
  return `M${x},${y0}V${y1 + dir * r}Q${x},${y1} ${x + r},${y1}H${x + w - r}Q${x + w},${y1} ${x + w},${y1 + dir * r}V${y0}Z`;
}

function useWidth(): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const observer = new ResizeObserver(([e]) => setWidth(Math.floor(e.contentRect.width)));
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

interface Tip {
  x: number;
  y: number;
  title: string;
  rows: { color: string; name: string; value: string }[];
}

function Tooltip({ tip, width }: { tip: Tip | null; width: number }) {
  if (!tip) return null;
  const left = tip.x > width * 0.6;
  return (
    <div className="wg-tip" style={{ left: tip.x, top: tip.y, transform: `translate(${left ? 'calc(-100% - 12px)' : '12px'}, -50%)` }}>
      <b>{tip.title}</b>
      {tip.rows.map((r) => (
        <span key={r.name}>
          <i style={{ background: r.color }} />
          {r.name && <small>{r.name}</small>}
          {r.value}
        </span>
      ))}
    </div>
  );
}

function Legend({ series }: { series: { name: string; color: string }[] }) {
  if (series.length < 2) return null;
  return (
    <div className="wg-legend">
      {series.map((s) => (
        <span key={s.name}>
          <i style={{ background: s.color }} />
          {s.name}
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- line & area

function LineChart({ labels, series, unit, width, area }: { labels: string[]; series: Series[]; unit?: string; width: number; area: boolean }) {
  const [hover, setHover] = useState<number | null>(null);
  const height = Math.max(220, Math.min(380, width * 0.5));
  const values = series.flatMap((s) => s.values).filter(Number.isFinite);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const ticks = niceTicks(area ? Math.min(0, lo) : lo - (hi - lo) * 0.08, hi + (hi - lo) * 0.08);
  const yMin = ticks[0];
  const yMax = ticks[ticks.length - 1];
  const tickText = ticks.map((v) => formatNumber(v, true));
  const direct = series.length >= 2 && series.length <= 4;
  const m = { top: 14, right: direct ? 96 : 16, bottom: 28, left: Math.max(...tickText.map((t) => t.length)) * 7 + 14 };
  const w = width - m.left - m.right;
  const h = height - m.top - m.bottom;
  const x = (i: number) => m.left + (labels.length === 1 ? w / 2 : (i / (labels.length - 1)) * w);
  const y = (v: number) => m.top + (1 - (v - yMin) / (yMax - yMin || 1)) * h;
  const every = Math.max(1, Math.ceil(labels.length / Math.max(2, Math.floor(w / 90))));

  const path = (s: Series) =>
    s.values
      .map((v, i) => (Number.isFinite(v) ? `${i && Number.isFinite(s.values[i - 1]) ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}` : ''))
      .join('');

  const onMove = (e: ReactPointerEvent<SVGRectElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    setHover(Math.max(0, Math.min(labels.length - 1, Math.round(ratio * (labels.length - 1)))));
  };
  const tip: Tip | null =
    hover === null
      ? null
      : {
          x: x(hover),
          y: m.top + h / 2,
          title: labels[hover],
          rows: series.map((s) => ({ color: s.color, name: series.length > 1 ? s.name : '', value: Number.isFinite(s.values[hover]) ? withUnit(s.values[hover], unit) : '—' })),
        };

  return (
    <div className="wg-chart-plot">
      <svg width={width} height={height} role="img" aria-label={series.map((s) => s.name).join(', ')}>
        <defs>
          {series.map((s, i) => (
            <linearGradient key={s.name} id={`wg-area-${i}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={s.color} stopOpacity={series.length > 1 ? 0.18 : 0.3} />
              <stop offset="100%" stopColor={s.color} stopOpacity="0" />
            </linearGradient>
          ))}
        </defs>
        {ticks.map((v, i) => (
          <g key={v}>
            <line className="wg-grid" x1={m.left} x2={m.left + w} y1={y(v)} y2={y(v)} />
            <text className="wg-axis" x={m.left - 8} y={y(v)} textAnchor="end" dominantBaseline="middle">
              {tickText[i]}
            </text>
          </g>
        ))}
        {labels.map((l, i) =>
          i % every === 0 || i === labels.length - 1 ? (
            <text key={i} className="wg-axis" x={x(i)} y={height - 8} textAnchor={i === 0 ? 'start' : i === labels.length - 1 ? 'end' : 'middle'}>
              {l.length > 12 ? `${l.slice(0, 11)}…` : l}
            </text>
          ) : null,
        )}
        {series.map((s, i) => (
          <g key={s.name}>
            {area && (
              <motion.path
                d={`${path(s)}L${x(labels.length - 1)},${y(Math.max(yMin, 0))}L${x(0)},${y(Math.max(yMin, 0))}Z`}
                fill={`url(#wg-area-${i})`}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.8, delay: 0.3 }}
              />
            )}
            <motion.path
              d={path(s)}
              fill="none"
              stroke={s.color}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              style={{ filter: `drop-shadow(0 0 3px ${s.color}88)` }}
              initial={{ pathLength: 0 }}
              animate={{ pathLength: 1 }}
              transition={{ duration: 1.1, delay: i * 0.12, ease: [0.16, 1, 0.3, 1] }}
            />
            {direct && Number.isFinite(s.values[s.values.length - 1]) && (
              <text className="wg-direct" x={x(labels.length - 1) + 8} y={y(s.values[s.values.length - 1])} dominantBaseline="middle">
                <tspan fill={s.color}>●</tspan> {s.name.length > 11 ? `${s.name.slice(0, 10)}…` : s.name}
              </text>
            )}
          </g>
        ))}
        {hover !== null && (
          <g>
            <line className="wg-cross" x1={x(hover)} x2={x(hover)} y1={m.top} y2={m.top + h} />
            {series.map((s) =>
              Number.isFinite(s.values[hover]) ? <circle key={s.name} cx={x(hover)} cy={y(s.values[hover])} r={4.5} fill={s.color} stroke={SURFACE} strokeWidth={2} /> : null,
            )}
          </g>
        )}
        <rect x={m.left} y={m.top} width={w} height={h} fill="transparent" onPointerMove={onMove} onPointerLeave={() => setHover(null)} />
      </svg>
      <Tooltip tip={tip} width={width} />
    </div>
  );
}

// ---------------------------------------------------------------- bars

function BarChart({ labels, series, unit, width }: { labels: string[]; series: Series[]; unit?: string; width: number }) {
  const [hover, setHover] = useState<{ i: number; s: number } | null>(null);
  const horizontal = series.length === 1 && (labels.length > 10 || labels.reduce((n, l) => n + l.length, 0) / labels.length > 10);
  const values = series.flatMap((s) => s.values).filter(Number.isFinite);
  const ticks = niceTicks(Math.min(0, ...values), Math.max(0, ...values));
  const vMin = ticks[0];
  const vMax = ticks[ticks.length - 1];
  const tickText = ticks.map((v) => formatNumber(v, true));
  const showValues = series.length === 1 && labels.length <= 14;

  if (horizontal) {
    const labelW = Math.min(170, Math.max(...labels.map((l) => l.length)) * 7 + 12);
    const bandH = 26;
    const m = { top: 8, right: showValues ? 70 : 16, bottom: 24, left: labelW };
    const height = m.top + m.bottom + labels.length * bandH;
    const w = width - m.left - m.right;
    const vx = (v: number) => m.left + ((v - vMin) / (vMax - vMin || 1)) * w;
    const s = series[0];
    return (
      <div className="wg-chart-plot">
        <svg width={width} height={height} role="img" aria-label={s.name}>
          {ticks.map((v, i) => (
            <g key={v}>
              <line className="wg-grid" x1={vx(v)} x2={vx(v)} y1={m.top} y2={height - m.bottom} />
              <text className="wg-axis" x={vx(v)} y={height - 6} textAnchor="middle">
                {tickText[i]}
              </text>
            </g>
          ))}
          {labels.map((l, i) => {
            const v = s.values[i];
            const top = m.top + i * bandH + 4;
            const barH = bandH - 8;
            return (
              <g key={i} onPointerEnter={() => setHover({ i, s: 0 })} onPointerLeave={() => setHover(null)}>
                <rect x={0} y={top - 3} width={width} height={bandH - 2} fill="transparent" />
                <text className="wg-cat" x={m.left - 8} y={top + barH / 2} textAnchor="end" dominantBaseline="middle">
                  {l.length > 24 ? `${l.slice(0, 23)}…` : l}
                </text>
                {Number.isFinite(v) && (
                  <motion.path
                    d={barPath(top, vx(0), vx(v), barH, true)}
                    fill={s.color}
                    opacity={hover && hover.i !== i ? 0.45 : 1}
                    initial={{ scaleX: 0 }}
                    animate={{ scaleX: 1 }}
                    style={{ originX: `${vx(0)}px` }}
                    transition={{ duration: 0.6, delay: i * 0.03 }}
                  />
                )}
                {showValues && Number.isFinite(v) && (
                  <text className="wg-value" x={vx(v) + (v >= 0 ? 6 : -6)} y={top + barH / 2} textAnchor={v >= 0 ? 'start' : 'end'} dominantBaseline="middle">
                    {withUnit(v, unit, true)}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
    );
  }

  const height = Math.max(220, Math.min(360, width * 0.5));
  const m = { top: showValues ? 22 : 12, right: 12, bottom: 30, left: Math.max(...tickText.map((t) => t.length)) * 7 + 14 };
  const w = width - m.left - m.right;
  const h = height - m.top - m.bottom;
  const y = (v: number) => m.top + (1 - (v - vMin) / (vMax - vMin || 1)) * h;
  const band = w / labels.length;
  const k = series.length;
  // Thin marks: bars stay slim however wide the panel is.
  const barW = Math.max(2, Math.min(44, (band * 0.72 - 2 * (k - 1)) / k));
  const group = barW * k + 2 * (k - 1);
  const every = Math.max(1, Math.ceil(labels.length / Math.max(2, Math.floor(w / 70))));
  const tip: Tip | null = hover
    ? {
        x: m.left + hover.i * band + band / 2,
        y: y(series[hover.s].values[hover.i] || 0),
        title: labels[hover.i],
        rows: series.map((s) => ({ color: s.color, name: k > 1 ? s.name : '', value: Number.isFinite(s.values[hover.i]) ? withUnit(s.values[hover.i], unit) : '—' })),
      }
    : null;

  return (
    <div className="wg-chart-plot">
      <svg width={width} height={height} role="img" aria-label={series.map((s) => s.name).join(', ')}>
        {ticks.map((v, i) => (
          <g key={v}>
            <line className={v === 0 ? 'wg-baseline' : 'wg-grid'} x1={m.left} x2={m.left + w} y1={y(v)} y2={y(v)} />
            <text className="wg-axis" x={m.left - 8} y={y(v)} textAnchor="end" dominantBaseline="middle">
              {tickText[i]}
            </text>
          </g>
        ))}
        {labels.map((l, i) => {
          const gx = m.left + i * band + (band - group) / 2;
          return (
            <g key={i} onPointerEnter={() => setHover({ i, s: 0 })} onPointerLeave={() => setHover(null)}>
              <rect x={m.left + i * band} y={m.top} width={band} height={h} fill="transparent" />
              {series.map((s, j) => {
                const v = s.values[i];
                if (!Number.isFinite(v)) return null;
                const bx = gx + j * (barW + 2);
                return (
                  <g key={s.name}>
                    <motion.path
                      d={barPath(bx, y(0), y(v), barW)}
                      fill={s.color}
                      opacity={hover && hover.i !== i ? 0.45 : 1}
                      initial={{ scaleY: 0 }}
                      animate={{ scaleY: 1 }}
                      style={{ originY: `${y(0)}px` }}
                      transition={{ duration: 0.6, delay: i * 0.03 }}
                    />
                    {showValues && (
                      <text className="wg-value" x={bx + barW / 2} y={y(v) + (v >= 0 ? -6 : 14)} textAnchor="middle">
                        {withUnit(v, unit, true)}
                      </text>
                    )}
                  </g>
                );
              })}
              {(i % every === 0 || labels.length <= 12) && (
                <text className="wg-cat" x={m.left + i * band + band / 2} y={height - 10} textAnchor="middle">
                  {l.length > Math.max(6, band / 7) ? `${l.slice(0, Math.max(5, Math.floor(band / 7) - 1))}…` : l}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <Tooltip tip={tip} width={width} />
    </div>
  );
}

// ---------------------------------------------------------------- donut

function DonutChart({ labels, values, unit, width }: { labels: string[]; values: number[]; unit?: string; width: number }) {
  const [hover, setHover] = useState<number | null>(null);
  // Past eight slices, the smallest fold into "Other".
  const slices = useMemo(() => {
    const all = labels.map((l, i) => ({ label: l, value: Math.max(0, values[i] || 0) })).filter((s) => s.value > 0);
    if (all.length <= 8) return all.map((s, i) => ({ ...s, color: CATEGORICAL[i] }));
    const kept = [...all].sort((a, b) => b.value - a.value).slice(0, 7);
    const rest = all.filter((s) => !kept.includes(s)).reduce((n, s) => n + s.value, 0);
    return [...all.filter((s) => kept.includes(s)).map((s, i) => ({ ...s, color: CATEGORICAL[i] })), { label: t().chart.other, value: rest, color: OTHER }];
  }, [labels, values]);
  const total = slices.reduce((n, s) => n + s.value, 0) || 1;
  const size = Math.max(160, Math.min(260, width * 0.45));
  const r = size / 2 - 4;
  const inner = r * 0.62;
  let angle = -Math.PI / 2;
  const arcs = slices.map((s) => {
    const a0 = angle;
    const a1 = angle + (s.value / total) * Math.PI * 2;
    angle = a1;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const p = (a: number, rad: number) => `${size / 2 + rad * Math.cos(a)},${size / 2 + rad * Math.sin(a)}`;
    const full = a1 - a0 >= Math.PI * 2 - 1e-6;
    const d = full
      ? `M${p(0, r)}A${r},${r} 0 1 1 ${p(Math.PI, r)}A${r},${r} 0 1 1 ${p(0, r)}M${p(0, inner)}A${inner},${inner} 0 1 0 ${p(Math.PI, inner)}A${inner},${inner} 0 1 0 ${p(0, inner)}Z`
      : `M${p(a0, r)}A${r},${r} 0 ${large} 1 ${p(a1, r)}L${p(a1, inner)}A${inner},${inner} 0 ${large} 0 ${p(a0, inner)}Z`;
    return { ...s, d };
  });
  const focus = hover !== null ? slices[hover] : null;
  const pct = (v: number) => `${((v / total) * 100).toLocaleString(uiLocale(), { maximumFractionDigits: 1 })} %`;

  return (
    <div className="wg-donut">
      <svg width={size} height={size} role="img" aria-label={labels.join(', ')}>
        {arcs.map((a, i) => (
          <motion.path
            key={a.label}
            d={a.d}
            fill={a.color}
            stroke={SURFACE}
            strokeWidth={2}
            fillRule="evenodd"
            opacity={hover !== null && hover !== i ? 0.4 : 1}
            onPointerEnter={() => setHover(i)}
            onPointerLeave={() => setHover(null)}
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: hover !== null && hover !== i ? 0.4 : 1, scale: 1 }}
            style={{ originX: '50%', originY: '50%' }}
            transition={{ duration: 0.5, delay: i * 0.05 }}
          />
        ))}
        <text className="wg-donut-value" x={size / 2} y={size / 2 - 4} textAnchor="middle">
          {focus ? pct(focus.value) : withUnit(total, unit, true)}
        </text>
        <text className="wg-axis" x={size / 2} y={size / 2 + 14} textAnchor="middle">
          {focus ? (focus.label.length > 18 ? `${focus.label.slice(0, 17)}…` : focus.label) : t().chart.total}
        </text>
      </svg>
      <ul className="wg-donut-legend">
        {slices.map((s, i) => (
          <li key={s.label} className={hover === i ? 'is-hover' : ''} onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)}>
            <i style={{ background: s.color }} />
            <span>{s.label}</span>
            <b>{withUnit(s.value, unit)}</b>
            {unit !== '%' && <small>{pct(s.value)}</small>}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------- widget

export function ChartWidget({ spec }: { spec: WidgetSpec }) {
  const { labels, series, type: initial } = useMemo(() => normalize(spec), [spec]);
  const [type, setType] = useState<ChartType>(initial);
  const [table, setTable] = useState(false);
  const [ref, width] = useWidth();
  const m = useT().chart;
  const types: [ChartType, string][] = [
    ['line', m.types.line],
    ['area', m.types.area],
    ['bar', m.types.bar],
    ...(series.length === 1 ? ([['pie', m.types.pie]] as [ChartType, string][]) : []),
  ];
  const empty = !series.some((s) => s.values.some(Number.isFinite));

  return (
    <div className="wg-chart">
      <div className="wg-chart-tools">
        <div className="vis-tabs" role="tablist">
          {types.map(([id, label]) => (
            <button key={id} type="button" className={!table && type === id ? 'on' : ''} onClick={() => (setType(id), setTable(false))}>
              {label}
            </button>
          ))}
          <button type="button" className={table ? 'on' : ''} onClick={() => setTable(true)}>
            {m.table}
          </button>
        </div>
        {!table && type !== 'pie' && <Legend series={series} />}
      </div>
      <div ref={ref} className="wg-chart-body">
        {empty ? (
          <p className="brief-meta">{m.noValues}</p>
        ) : table ? (
          <table className="wg-table">
            <thead>
              <tr>
                <th />
                {series.map((s) => (
                  <th key={s.name} className="is-num">
                    {s.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {labels.map((l, i) => (
                <tr key={i}>
                  <td>{l}</td>
                  {series.map((s) => (
                    <td key={s.name} className="is-num">
                      {Number.isFinite(s.values[i]) ? withUnit(s.values[i], spec.unit) : '—'}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        ) : width === 0 ? null : type === 'pie' ? (
          <DonutChart labels={labels} values={series[0].values} unit={spec.unit} width={width} />
        ) : type === 'bar' ? (
          <BarChart labels={labels} series={series} unit={spec.unit} width={width} />
        ) : (
          <LineChart labels={labels} series={series} unit={spec.unit} width={width} area={type === 'area'} />
        )}
      </div>
    </div>
  );
}
