import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { motion } from 'framer-motion';
import { fetchPriceHistory, type ChartRange, type StockQuote } from '../assistant/tools';
import { uiLocale, useT } from '../../i18n';

/**
 * Animated market chart: the line draws itself with a glowing area under it, the last price
 * pulses, a crosshair reads any point, and range buttons load 5 days to 5 years of history
 * (Yahoo Finance, free, cached a few minutes).
 */

const W = 300;
const H = 110;
const PAD = 6;

const RANGES: ChartRange[] = ['1d', '5d', '1mo', '6mo', '1y', '5y'];

interface Series {
  points: number[];
  times: number[];
}

export function HoloChart({ quote }: { quote: StockQuote }) {
  const locale = uiLocale();
  const t = useT().chart;
  const [range, setRange] = useState<ChartRange>('1d');
  const [series, setSeries] = useState<Series>({ points: quote.points, times: quote.times ?? [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  // A live card: the day's line follows the new prices.
  useEffect(() => {
    if (range === '1d') setSeries({ points: quote.points, times: quote.times ?? [] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quote]);
  const request = useRef(0);

  const choose = (next: ChartRange) => {
    if (next === range && !error) return;
    setRange(next);
    setHover(null);
    if (next === '1d') {
      setSeries({ points: quote.points, times: quote.times ?? [] });
      setError(false);
      return;
    }
    const id = ++request.current;
    setLoading(true);
    fetchPriceHistory(quote.symbol, next)
      .then((s) => {
        if (id !== request.current) return;
        setSeries(s);
        setError(false);
      })
      .catch(() => id === request.current && setError(true))
      .finally(() => id === request.current && setLoading(false));
  };

  const { points, times } = series;
  const geometry = useMemo(() => {
    if (points.length < 2) return null;
    // The previous close is part of the day's scale, so the dashed line stays on the chart.
    const base = range === '1d' ? quote.previousClose : null;
    const values = base !== null ? [...points, base] : points;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    const x = (i: number) => (i / (points.length - 1)) * W;
    const y = (v: number) => PAD + (1 - (v - min) / span) * (H - PAD * 2);
    const line = points.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(2)},${y(v).toFixed(2)}`).join('');
    return { x, y, line, area: `${line}L${W},${H}L0,${H}Z`, base: base !== null ? y(base) : null };
  }, [points, range, quote.previousClose]);

  const first = points[0];
  const lastValue = points[points.length - 1];
  const reference = range === '1d' && quote.previousClose !== null ? quote.previousClose : first;
  const up = lastValue >= reference;
  const change = reference ? ((lastValue - reference) / reference) * 100 : 0;
  const tone = up ? 'up' : 'down';
  const money = (v: number) => v.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const when = (ms: number) =>
    new Date(ms).toLocaleString(
      locale,
      range === '1d' || range === '5d' ? { weekday: 'short', hour: '2-digit', minute: '2-digit' } : { day: 'numeric', month: 'short', year: 'numeric' },
    );

  // SVG ids can't hold "^" or "=" ("^FCHI", "EURUSD=X").
  const gradientKey = quote.symbol.replace(/[^a-z0-9]/gi, '');

  const onMove = (e: ReactPointerEvent) => {
    const rect = box.current?.getBoundingClientRect();
    if (!rect || points.length < 2) return;
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    setHover(Math.round(ratio * (points.length - 1)));
  };

  return (
    <div className={`holo-chart holo-chart--${tone}`}>
      <div className="holo-chart-ranges" role="tablist">
        {RANGES.map((r) => (
          <button key={r} type="button" role="tab" aria-selected={range === r} className={range === r ? 'is-active' : ''} onClick={() => choose(r)}>
            {t.ranges[r]}
          </button>
        ))}
        {geometry && (
          <span className={`holo-chart-change brief-stock-change--${tone}`}>
            {up ? '+' : '−'}
            {Math.abs(change).toFixed(2)} %
          </span>
        )}
      </div>
      <div ref={box} className={`holo-chart-plot${loading ? ' is-loading' : ''}`} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        {geometry ? (
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden>
            <defs>
              <linearGradient id={`holo-fill-${gradientKey}-${tone}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" className="holo-chart-stop" stopOpacity="0.35" />
                <stop offset="100%" className="holo-chart-stop" stopOpacity="0" />
              </linearGradient>
            </defs>
            {[0.25, 0.5, 0.75].map((f) => (
              <line key={f} className="holo-chart-grid" x1="0" x2={W} y1={H * f} y2={H * f} vectorEffect="non-scaling-stroke" />
            ))}
            {geometry.base !== null && (
              <line className="holo-chart-base" x1="0" x2={W} y1={geometry.base} y2={geometry.base} vectorEffect="non-scaling-stroke" />
            )}
            <motion.path
              key={`area-${range}-${points.length}`}
              d={geometry.area}
              fill={`url(#holo-fill-${gradientKey}-${tone})`}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.8, delay: 0.3 }}
            />
            <motion.path
              key={`line-${range}-${points.length}`}
              className="holo-chart-line"
              d={geometry.line}
              vectorEffect="non-scaling-stroke"
              initial={{ pathLength: 0 }}
              animate={{ pathLength: 1 }}
              transition={{ duration: 1.1, ease: [0.16, 1, 0.3, 1] }}
            />
            {hover !== null && (
              <line className="holo-chart-cross" x1={geometry.x(hover)} x2={geometry.x(hover)} y1="0" y2={H} vectorEffect="non-scaling-stroke" />
            )}
          </svg>
        ) : (
          <p className="brief-meta">{error ? t.historyUnavailable : t.notEnoughData}</p>
        )}
        {geometry && (
          // Dots are HTML so they stay round on the stretched SVG.
          <>
            <span className="holo-chart-dot holo-chart-dot--last" style={{ left: '100%', top: `${(geometry.y(lastValue) / H) * 100}%` }} />
            {hover !== null && (
              <>
                <span className="holo-chart-dot" style={{ left: `${(geometry.x(hover) / W) * 100}%`, top: `${(geometry.y(points[hover]) / H) * 100}%` }} />
                <span className={`holo-chart-tip${hover > points.length / 2 ? ' is-left' : ''}`} style={{ left: `${(geometry.x(hover) / W) * 100}%` }}>
                  <b>{money(points[hover])}</b> {quote.currency}
                  {times[hover] ? <small>{when(times[hover])}</small> : null}
                </span>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
