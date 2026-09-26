import { useId, type CSSProperties } from 'react';
import type { Phase } from '../assistant/useAssistant';
import './IrisLogo.css';

/**
 * Iris's logo: the iris of an eye drawn as a camera aperture. Six blades close on a hexagonal
 * pupil, over the radial fibres of an iris, with a catchlight. Animated in CSS: the blades turn,
 * the pupil breathes when idle, opens wide when listening, closes and spins when thinking, and
 * follows `level` (0..1, the voice) when given.
 *
 * The app icon (src-tauri/icons/icon.svg) is the same drawing on a dark tile.
 */

/** Drawing units: the view box is centred on 0 and 1024 wide. */
export const IRIS_RADIUS = 300;
export const PUPIL_APOTHEM = 130;
const BLADES = 6;

type Point = [number, number];
const pt = ([x, y]: Point) => `${x.toFixed(1)} ${y.toFixed(1)}`;

/** The blades (paths tiling the ring between the pupil and the iris edge) and the pupil's corners. */
export function aperture(apothem = PUPIL_APOTHEM, radius = IRIS_RADIUS, blades = BLADES) {
  const half = apothem * Math.tan(Math.PI / blades);
  const reach = Math.sqrt(radius * radius - apothem * apothem);
  // Blade i's edge is the line tangent to the pupil at angle θ; it meets the next edge at a
  // corner of the pupil, and the iris edge further out.
  const lines = Array.from({ length: blades }, (_, i) => {
    const θ = (i / blades) * Math.PI * 2 - Math.PI / 2;
    const n: Point = [Math.cos(θ), Math.sin(θ)];
    const d: Point = [-Math.sin(θ), Math.cos(θ)];
    const at = (s: number): Point => [apothem * n[0] + s * d[0], apothem * n[1] + s * d[1]];
    return { corner: at(half), outer: at(reach) };
  });
  const paths = lines.map((line, i) => {
    const next = lines[(i + 1) % blades];
    return `M${pt(line.corner)} L${pt(line.outer)} A${radius} ${radius} 0 0 1 ${pt(next.outer)} L${pt(next.corner)} Z`;
  });
  return { paths, pupil: lines.map((l) => pt(l.corner)).join(' ') };
}

/** Deterministic 0..1 noise, so the fibres are the same at every render. */
const noise = (i: number, k: number) => {
  const x = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453;
  return x - Math.floor(x);
};

/** Radial fibres of the iris: [x1, y1, x2, y2, width, opacity]. */
export const FIBERS = Array.from({ length: 84 }, (_, i) => {
  const a = (i / 84) * Math.PI * 2 + (noise(i, 1) - 0.5) * 0.06;
  const r0 = PUPIL_APOTHEM * 1.05 + noise(i, 2) * 30;
  const r1 = IRIS_RADIUS * (0.7 + 0.27 * noise(i, 3));
  return [Math.cos(a) * r0, Math.sin(a) * r0, Math.cos(a) * r1, Math.sin(a) * r1, 3 + noise(i, 4) * 4, 0.25 + 0.6 * noise(i, 5)] as const;
});

/** Graduations around the iris: [x1, y1, x2, y2, major]. */
const TICKS = Array.from({ length: 72 }, (_, i) => {
  const a = (i / 72) * Math.PI * 2;
  const r0 = i % 6 === 0 ? 338 : 354;
  return [Math.cos(a) * r0, Math.sin(a) * r0, Math.cos(a) * 372, Math.sin(a) * 372, i % 6 === 0] as const;
});

const { paths: BLADE_PATHS, pupil: PUPIL } = aperture();

interface IrisLogoProps {
  size: number;
  phase?: Phase;
  /** Voice level 0..1: the pupil opens with it. */
  level?: number;
  /** The graduated outer ring (off for very small sizes). */
  ring?: boolean;
  className?: string;
}

export function IrisLogo({ size, phase = 'idle', level = 0, ring = true, className = '' }: IrisLogoProps) {
  const id = useId().replace(/:/g, '');
  return (
    <svg
      className={`iris-logo iris-logo--${phase} ${className}`}
      width={size}
      height={size}
      viewBox={ring ? '-512 -512 1024 1024' : '-330 -330 660 660'}
      style={{ '--level': Math.min(1, Math.max(0, level)) } as CSSProperties}
      aria-hidden
    >
      <defs>
        <radialGradient id={`${id}-iris`}>
          <stop offset="0.35" className="iris-logo__stop-deep" />
          <stop offset="0.8" className="iris-logo__stop-mid" />
          <stop offset="1" className="iris-logo__stop-rim" />
        </radialGradient>
        <linearGradient id={`${id}-blade`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" className="iris-logo__stop-blade" />
          <stop offset="1" className="iris-logo__stop-clear" />
        </linearGradient>
        <clipPath id={`${id}-clip`}>
          <circle r={IRIS_RADIUS} />
        </clipPath>
      </defs>

      {ring && (
        <g className="iris-logo__ring">
          {TICKS.map(([x1, y1, x2, y2, major], i) => (
            <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} className={major ? 'iris-logo__tick iris-logo__tick--major' : 'iris-logo__tick'} />
          ))}
          <circle r={412} pathLength={360} className="iris-logo__arcs" />
        </g>
      )}

      <circle r={IRIS_RADIUS} fill={`url(#${id}-iris)`} />
      <g className="iris-logo__fibers">
        {FIBERS.map(([x1, y1, x2, y2, w, o], i) => (
          <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} strokeWidth={w} strokeOpacity={o} />
        ))}
      </g>

      <g clipPath={`url(#${id}-clip)`}>
        <g className="iris-logo__dilate">
          <g className="iris-logo__breathe">
            <g className="iris-logo__spin">
              {BLADE_PATHS.map((d, i) => (
                <path key={i} d={d} className="iris-logo__blade" fill={i % 2 ? `url(#${id}-blade)` : undefined} />
              ))}
              <polygon points={PUPIL} className="iris-logo__pupil" />
            </g>
          </g>
        </g>
      </g>

      <circle r={IRIS_RADIUS} className="iris-logo__limbus" />
      <circle cx={-46} cy={-50} r={22} className="iris-logo__glint" />
      <circle cx={36} cy={38} r={8} className="iris-logo__glint iris-logo__glint--small" />
    </svg>
  );
}
