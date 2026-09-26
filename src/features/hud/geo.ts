import type { GeoPoint } from '../assistant/tools';
import { uiLocale } from '../../i18n';

/** Geometry shared by the globe and the flat map: great-circle routes and the heat scale. */

const RAD = Math.PI / 180;

export interface Route {
  from: GeoPoint;
  to: GeoPoint;
  color?: string;
  label?: string;
}

const toVec = (lat: number, lon: number) => [Math.cos(lat * RAD) * Math.cos(lon * RAD), Math.cos(lat * RAD) * Math.sin(lon * RAD), Math.sin(lat * RAD)];

/** Angle between two places, in radians. */
export function arcAngle(a: GeoPoint, b: GeoPoint): number {
  const [x1, y1, z1] = toVec(a.lat, a.lon);
  const [x2, y2, z2] = toVec(b.lat, b.lon);
  return Math.acos(Math.max(-1, Math.min(1, x1 * x2 + y1 * y2 + z1 * z2)));
}

const EARTH_RADIUS_KM = 6371;

/** Great-circle distance (what a plane flies), in km. */
export function distanceKm(a: GeoPoint, b: GeoPoint): number {
  return arcAngle(a, b) * EARTH_RADIUS_KM;
}

/** "9 712 km", "850 km", "4,2 km". */
export function formatKm(km: number): string {
  return `${km.toLocaleString(uiLocale(), { maximumFractionDigits: km < 10 ? 1 : 0 })} km`;
}

// ---------------------------------------------------------------- outlines

export interface Outline {
  /** lon, lat, lon, lat… */
  points: Float32Array;
  border: boolean;
}

let outlines: Outline[] | null = null;

/** Coastlines and borders (see outlines.ts), decoded the first time they are drawn. */
export async function loadOutlines(): Promise<Outline[]> {
  if (outlines) return outlines;
  const { OUTLINE_POINTS, OUTLINE_LENGTHS, OUTLINE_BORDERS } = await import('./outlines');
  const bytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const points = new Int16Array(bytes(OUTLINE_POINTS).buffer);
  const lengths = new Uint16Array(bytes(OUTLINE_LENGTHS).buffer);
  const borders = bytes(OUTLINE_BORDERS);
  const list: Outline[] = [];
  let at = 0;
  lengths.forEach((n, i) => {
    const line = new Float32Array(n * 2);
    for (let k = 0; k < n * 2; k++) line[k] = points[at * 2 + k] / 100;
    at += n;
    list.push({ points: line, border: (borders[i >> 3] & (1 << (i & 7))) !== 0 });
  });
  outlines = list;
  return list;
}

/** Points along the shortest path between two places (what a plane flies): [lat, lon]. */
export function greatCircle(a: GeoPoint, b: GeoPoint, steps = 64): [number, number][] {
  const va = toVec(a.lat, a.lon);
  const vb = toVec(b.lat, b.lon);
  const omega = arcAngle(a, b);
  if (omega < 1e-6) return [[a.lat, a.lon], [b.lat, b.lon]];
  const points: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const k1 = Math.sin((1 - t) * omega) / Math.sin(omega);
    const k2 = Math.sin(t * omega) / Math.sin(omega);
    const [x, y, z] = [0, 1, 2].map((d) => k1 * va[d] + k2 * vb[d]);
    points.push([Math.atan2(z, Math.hypot(x, y)) / RAD, Math.atan2(y, x) / RAD]);
  }
  return points;
}

/** A small label with a dark plate behind it (distances, values) centred on (x, y). */
export function drawTag(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string, fontSize = 10) {
  ctx.font = `600 ${fontSize}px "JetBrains Mono", ui-monospace, Consolas, monospace`;
  const w = ctx.measureText(text).width;
  ctx.fillStyle = 'rgba(5, 8, 4, 0.88)';
  ctx.fillRect(x - w / 2 - 4, y - fontSize / 2 - 4, w + 8, fontSize + 7);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.strokeRect(x - w / 2 - 4, y - fontSize / 2 - 4, w + 8, fontSize + 7);
  ctx.fillStyle = '#e6f5d6';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y + 0.5);
  ctx.textBaseline = 'alphabetic';
}

/** Arrowhead at (x, y) pointing along (dx, dy). */
export function drawArrow(ctx: CanvasRenderingContext2D, x: number, y: number, dx: number, dy: number, size = 7) {
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x - ux * size - uy * size * 0.55, y - uy * size + ux * size * 0.55);
  ctx.lineTo(x - ux * size + uy * size * 0.55, y - uy * size - ux * size * 0.55);
  ctx.closePath();
  ctx.fill();
}

// ---------------------------------------------------------------- heat scale

/**
 * Sequential green ramp in the HUD's hue, dark to light: on the black HUD a low value recedes
 * towards the surface and a high one glows.
 */
const RAMP = ['#1d3300', '#274400', '#315600', '#3c6800', '#487b00', '#558e00', '#63a100', '#76b900', '#8fcb2a', '#a8da57', '#c1e785', '#daf3b4'];
/** Countries without a value. */
export const NO_DATA = '#3a4236';

const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

export function rampColor(t: number): string {
  const x = Math.max(0, Math.min(1, t)) * (RAMP.length - 1);
  const i = Math.min(RAMP.length - 2, Math.floor(x));
  const a = hex(RAMP[i]);
  const b = hex(RAMP[i + 1]);
  const f = x - i;
  return `rgb(${a.map((v, k) => Math.round(v + (b[k] - v) * f)).join(',')})`;
}

export const RAMP_CSS = `linear-gradient(90deg, ${RAMP.join(', ')})`;

/**
 * Value → position on the ramp. Very skewed data (population, GDP: max ≥ 100 × min) uses a log
 * scale, so the smaller countries don't all look the same.
 */
export function heatScale(values: number[]): { t: (v: number) => number; log: boolean; min: number; max: number } {
  const finite = values.filter(Number.isFinite);
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const log = min > 0 && max / min >= 100;
  if (log) {
    const lo = Math.log(min);
    const span = Math.log(max) - lo || 1;
    return { t: (v) => (Math.log(Math.max(v, min)) - lo) / span, log, min, max };
  }
  return { t: (v) => (v - min) / (max - min || 1), log, min, max };
}
