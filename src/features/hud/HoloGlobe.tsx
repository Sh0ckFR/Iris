import { useEffect, useRef, useState, type RefObject } from 'react';
import type { GeoPoint } from '../assistant/tools';
import { LAND_MASK_BASE64, LAND_MASK_HEIGHT, LAND_MASK_WIDTH } from './landMask';
import { countryAt } from './countries';
import { arcAngle, drawArrow, drawTag, greatCircle, loadOutlines, type Outline, type Route } from './geo';
import { citiesAtZoom, drawCities, loadCities, type City } from './cities';

/**
 * A holographic globe (canvas 2D, orthographic projection): glowing land dots, a see-through far
 * side, a graticule and a scan line. It turns to bring the selected place in front and marks the
 * places with pulsing beacons. Interactive when asked: drag to turn, wheel to zoom, click a
 * beacon to select it. No WebGL context and no network: the land comes from landMask.ts.
 */

const RAD = Math.PI / 180;

const MASK = Uint8Array.from(atob(LAND_MASK_BASE64), (c) => c.charCodeAt(0));

/** Whether a point is on land (2° cells). */
export function isLand(lat: number, lon: number): boolean {
  const i = Math.min(LAND_MASK_WIDTH - 1, Math.max(0, Math.floor((lon + 180) / 2)));
  const j = Math.min(LAND_MASK_HEIGHT - 1, Math.max(0, Math.floor((90 - lat) / 2)));
  const n = j * LAND_MASK_WIDTH + i;
  return (MASK[n >> 3] & (1 << (n & 7))) !== 0;
}

/** Land dots, spread evenly over the sphere (fewer per row towards the poles). */
const LAND: [lat: number, lon: number][] = (() => {
  const dots: [number, number][] = [];
  const step = 2.2;
  for (let lat = -88; lat <= 88; lat += step) {
    const lonStep = step / Math.max(0.15, Math.cos(lat * RAD));
    for (let lon = -180; lon < 180; lon += lonStep) if (isLand(lat, lon)) dots.push([lat, lon]);
  }
  return dots;
})();

/** Country of each land dot (heat mode), computed the first time it is needed. */
let landCountries: Int16Array | null = null;
export const landCountry = (i: number) => (landCountries ??= Int16Array.from(LAND, ([lat, lon]) => countryAt(lat, lon)))[i];

/** Meridians and parallels every 30°, as dotted lines. */
const GRID: [number, number][] = (() => {
  const dots: [number, number][] = [];
  for (let lat = -60; lat <= 60; lat += 30) for (let lon = -180; lon < 180; lon += 3) dots.push([lat, lon]);
  for (let lon = -180; lon < 180; lon += 30) for (let lat = -84; lat <= 84; lat += 3) dots.push([lat, lon]);
  return dots;
})();

export const GLOBE_ACCENT = '#76b900';
export const GLOBE_BEACON = '#ffb347';

/** Shortest turn between two longitudes, in degrees (-180…180). */
const wrap = (deg: number) => ((((deg + 180) % 360) + 360) % 360) - 180;

/** Fills its parent (square) when `size` is "fill". */
function useSize(size: number | 'fill', el: RefObject<HTMLElement | null>): number {
  const [measured, setMeasured] = useState(typeof size === 'number' ? size : 0);
  useEffect(() => {
    if (typeof size === 'number') return setMeasured(size);
    const parent = el.current?.parentElement;
    if (!parent) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setMeasured(Math.max(120, Math.floor(Math.min(width, height))));
    });
    observer.observe(parent);
    return () => observer.disconnect();
  }, [size, el]);
  return measured;
}

export interface HoloGlobeProps {
  points: GeoPoint[];
  size?: number | 'fill';
  /** Place brought in front (default: the first). */
  selected?: number | null;
  onSelect?: (index: number) => void;
  /** Beacon colour per point (default amber). */
  colors?: string[];
  /** Drag, zoom and click. */
  interactive?: boolean;
  /** Labels on every beacon (otherwise only the selected one). */
  labelAll?: boolean;
  /** Keep turning slowly (otherwise it rests on the selected place). */
  autoRotate?: boolean;
  /** Arrows between places (great circles, animated). */
  routes?: Route[];
  /** Heat mode: colour of a country's land dots (null = no data). */
  dotColor?: (country: number) => string | null;
  /** The point under the mouse (interactive), for tooltips. */
  onHover?: (hit: { lat: number; lon: number; x: number; y: number } | null) => void;
  /** Places whose beacon only shows when selected (heat mode: the colours already show those countries). */
  quiet?: boolean[];
  /** Camera: the place to look at and how close (1 = whole globe … 10), e.g. asked by voice. */
  focus?: GeoPoint | null;
  zoom?: number;
  /** Changes with each camera order, so the same order given twice flies there again. */
  cameraKey?: number;
}

export const MAX_ZOOM = 10;

export function HoloGlobe({ points, size = 200, selected = 0, onSelect, colors, interactive = false, labelAll = false, autoRotate = false, routes, dotColor, onHover, quiet, focus, zoom, cameraKey }: HoloGlobeProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const px = useSize(size, canvas);
  // Props read by the animation loop without restarting it.
  const props = useRef({ points, selected, colors, labelAll, autoRotate, onSelect, routes, dotColor, onHover, quiet });
  props.current = { points, selected, colors, labelAll, autoRotate, onSelect, routes, dotColor, onHover, quiet };
  /**
   * Rotation and zoom (eased towards targetZoom), the place the camera was sent to (`target`,
   * else the selected place), and whether the user took control (dragged) since.
   */
  const view = useRef({ lon0: NaN, lat0: 20, zoom: 1, targetZoom: 1, target: null as GeoPoint | null, free: false });

  // A new selection: turn to it again.
  useEffect(() => {
    view.current.free = false;
    view.current.target = null;
  }, [selected, points]);
  // A camera order (`focus` / `zoom`): fly there.
  useEffect(() => {
    const v = view.current;
    if (!focus && zoom === undefined) return;
    if (focus) v.target = focus;
    if (zoom !== undefined) v.targetZoom = Math.max(0.8, Math.min(MAX_ZOOM, zoom));
    v.free = false;
  }, [focus?.lat, focus?.lon, zoom, cameraKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Coastlines and borders, and the major cities (landmarks when zoomed in), loaded once.
  const lines = useRef<Outline[] | null>(null);
  const cities = useRef<City[] | null>(null);
  useEffect(() => {
    void loadOutlines().then((o) => (lines.current = o));
    void loadCities().then((c) => (cities.current = c));
  }, []);

  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext('2d');
    if (!el || !ctx || px === 0) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    el.width = px * dpr;
    el.height = px * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const v = view.current;
    const focusOf = () => {
      const { points: pts, selected: sel } = props.current;
      return sel !== null && sel !== undefined ? pts[sel] : undefined;
    };
    if (Number.isNaN(v.lon0)) {
      const first = focusOf();
      v.lon0 = first ? first.lon - 70 : -20;
      v.lat0 = first ? first.lat * 0.6 : 20;
    }
    const cx = px / 2;
    const cy = px / 2;
    let raf = 0;
    const started = performance.now();
    let last = started;
    const fontSize = Math.max(9, Math.min(12, px / 36));

    const radius = () => px * 0.42 * v.zoom;
    const project = (lat: number, lon: number) => {
      const phi = lat * RAD;
      const dl = (lon - v.lon0) * RAD;
      const p0 = v.lat0 * RAD;
      const R = radius();
      const cosc = Math.sin(p0) * Math.sin(phi) + Math.cos(p0) * Math.cos(phi) * Math.cos(dl);
      const x = Math.cos(phi) * Math.sin(dl);
      const y = Math.cos(p0) * Math.sin(phi) - Math.sin(p0) * Math.cos(phi) * Math.cos(dl);
      return { x: cx + R * x, y: cy - R * y, front: cosc };
    };
    /** A point raised h × R above the centre (routes fly over the surface). */
    const projectRaised = (lat: number, lon: number, h: number) => {
      const p = project(lat, lon);
      const x = cx + (p.x - cx) * h;
      const y = cy + (p.y - cy) * h;
      // Visible in front of the globe, or beyond its silhouette.
      const visible = p.front > 0 || Math.hypot(x - cx, y - cy) > radius();
      return { x, y, visible };
    };
    /** Inverse projection: the place under a point of the canvas, or null off the globe. */
    const unproject = (x: number, y: number) => {
      const R = radius();
      const nx = (x - cx) / R;
      const ny = (cy - y) / R;
      const rho = Math.hypot(nx, ny);
      if (rho > 1) return null;
      if (rho < 1e-9) return { lat: v.lat0, lon: v.lon0 };
      const c = Math.asin(rho);
      const p0 = v.lat0 * RAD;
      const lat = Math.asin(Math.cos(c) * Math.sin(p0) + (ny * Math.sin(c) * Math.cos(p0)) / rho) / RAD;
      const lon = v.lon0 + Math.atan2(nx * Math.sin(c), rho * Math.cos(c) * Math.cos(p0) - ny * Math.sin(c) * Math.sin(p0)) / RAD;
      return { lat, lon: wrap(lon) };
    };

    // ---- interaction
    let drag: { x: number; y: number; moved: boolean } | null = null;
    const onDown = (e: PointerEvent) => {
      drag = { x: e.clientX, y: e.clientY, moved: false };
      el.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (!drag) {
        const hover = props.current.onHover;
        if (!hover) return;
        const rect = el.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const at = unproject(x, y);
        hover(at && { ...at, x, y });
        return;
      }
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      if (!drag.moved) return;
      v.free = true;
      const degPerPx = 180 / (Math.PI * radius());
      v.lon0 = wrap(v.lon0 - dx * degPerPx);
      v.lat0 = Math.max(-80, Math.min(80, v.lat0 + dy * degPerPx));
      drag.x = e.clientX;
      drag.y = e.clientY;
    };
    const onUp = (e: PointerEvent) => {
      const wasClick = drag && !drag.moved;
      drag = null;
      if (!wasClick || !props.current.onSelect) return;
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      let best = -1;
      let bestD = 14;
      props.current.points.forEach((p, i) => {
        const q = project(p.lat, p.lon);
        const d = Math.hypot(q.x - x, q.y - y);
        if (q.front > 0 && d < bestD) {
          best = i;
          bestD = d;
        }
      });
      if (best >= 0) props.current.onSelect(best);
    };
    const onLeave = () => props.current.onHover?.(null);
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      v.targetZoom = Math.max(0.8, Math.min(MAX_ZOOM, v.targetZoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    };
    if (interactive) {
      el.addEventListener('pointerdown', onDown);
      el.addEventListener('pointermove', onMove);
      el.addEventListener('pointerup', onUp);
      el.addEventListener('pointercancel', onUp);
      el.addEventListener('pointerleave', onLeave);
      el.addEventListener('wheel', onWheel, { passive: false });
    }

    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const focus = v.target ?? focusOf();
      const { points: pts, colors: cols, labelAll: all, autoRotate: spin } = props.current;
      v.zoom += (v.targetZoom - v.zoom) * Math.min(1, dt * 3);
      if (!drag) {
        if (focus && !v.free && !spin) {
          // Zoomed in: the place right in the centre; whole globe: slightly tilted, more elegant.
          const lat = v.targetZoom > 1.3 ? focus.lat : focus.lat * 0.6;
          v.lon0 += wrap(focus.lon - v.lon0) * Math.min(1, dt * 2.2);
          v.lat0 += (lat - v.lat0) * Math.min(1, dt * 2.2);
        } else if (spin || !focus) {
          v.lon0 = wrap(v.lon0 + (dt * 8) / v.zoom);
        }
      }
      const R = radius();

      ctx.clearRect(0, 0, px, px);
      ctx.save();
      // Atmosphere and disc.
      const halo = ctx.createRadialGradient(cx, cy, R * 0.85, cx, cy, R * 1.25);
      halo.addColorStop(0, 'rgba(118, 185, 0, 0.18)');
      halo.addColorStop(1, 'rgba(118, 185, 0, 0)');
      ctx.fillStyle = halo;
      ctx.fillRect(0, 0, px, px);
      const disc = ctx.createRadialGradient(cx - R * 0.35, cy - R * 0.35, R * 0.1, cx, cy, R);
      disc.addColorStop(0, 'rgba(60, 100, 10, 0.35)');
      disc.addColorStop(1, 'rgba(5, 9, 4, 0.55)');
      ctx.fillStyle = disc;
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(118, 185, 0, 0.55)';
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.fillStyle = GLOBE_ACCENT;
      const dot = Math.max(1, Math.min(2.4, R / 90));
      for (const [lat, lon] of GRID) {
        const p = project(lat, lon);
        if (p.front <= 0) continue;
        ctx.globalAlpha = 0.12 * p.front;
        ctx.fillRect(p.x - 0.4, p.y - 0.4, 0.8, 0.8);
      }
      const heat = props.current.dotColor;
      for (let k = 0; k < LAND.length; k++) {
        const [lat, lon] = LAND[k];
        const p = project(lat, lon);
        if (p.x < -4 || p.y < -4 || p.x > px + 4 || p.y > px + 4) continue;
        if (heat) {
          const country = landCountry(k);
          ctx.fillStyle = (country >= 0 && heat(country)) || '#3a4236';
        }
        // Far side: faint, as if seen through the hologram. Zoomed in, the outlines take over.
        const fade = Math.max(0.3, 1 - (v.zoom - 1) * 0.12);
        ctx.globalAlpha = (p.front > 0 ? 0.35 + 0.6 * p.front : 0.07) * fade;
        const s = p.front > 0 ? dot * (1 + p.front * 0.5) : dot * 0.7;
        ctx.fillRect(p.x - s / 2, p.y - s / 2, s, s);
      }

      // Coastlines (bright) and borders (dimmer): sharp at any zoom. Front side only.
      if (lines.current) {
        const coastAlpha = Math.min(0.9, 0.3 + 0.12 * v.zoom);
        ctx.lineWidth = v.zoom > 2 ? 1.2 : 0.8;
        for (const line of lines.current) {
          ctx.globalAlpha = line.border ? coastAlpha * 0.55 : coastAlpha;
          ctx.strokeStyle = GLOBE_ACCENT;
          ctx.beginPath();
          let pen = false;
          for (let k = 0; k < line.points.length; k += 2) {
            const q = project(line.points[k + 1], line.points[k]);
            if (q.front <= 0) {
              pen = false;
              continue;
            }
            if (pen) ctx.lineTo(q.x, q.y);
            else ctx.moveTo(q.x, q.y);
            pen = true;
          }
          ctx.stroke();
        }
      }

      // Scan line sweeping down the globe.
      const t = ((now - started) / 2600) % 1;
      const sy = cy - R + t * 2 * R;
      const half = Math.sqrt(Math.max(0, R * R - (sy - cy) ** 2));
      ctx.globalAlpha = 0.35 * Math.sin(t * Math.PI);
      ctx.strokeStyle = GLOBE_ACCENT;
      ctx.beginPath();
      ctx.moveTo(cx - half, sy);
      ctx.lineTo(cx + half, sy);
      ctx.stroke();

      // Routes: dashed great circles flowing towards their end, a comet and an arrowhead.
      (props.current.routes ?? []).forEach((route, r) => {
        const pts = greatCircle(route.from, route.to, 48);
        const lift = Math.min(0.22, arcAngle(route.from, route.to) * 0.14);
        const proj = pts.map(([lat, lon], i) => projectRaised(lat, lon, 1 + lift * Math.sin((Math.PI * i) / (pts.length - 1))));
        const color = route.color ?? GLOBE_BEACON;
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = 1.6;
        ctx.setLineDash([6, 5]);
        ctx.lineDashOffset = -((now - started) / 40) % 11;
        ctx.globalAlpha = 0.85;
        ctx.beginPath();
        proj.forEach((q, i) => (q.visible && i > 0 && proj[i - 1].visible ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
        ctx.stroke();
        ctx.setLineDash([]);
        const end = proj[proj.length - 1];
        const before = proj[proj.length - 3];
        if (end.visible && before) drawArrow(ctx, end.x, end.y, end.x - before.x, end.y - before.y);
        const t = ((now - started) / 2600 + r * 0.23) % 1;
        const comet = proj[Math.round(t * (proj.length - 1))];
        if (comet.visible) {
          ctx.globalAlpha = Math.sin(t * Math.PI);
          ctx.beginPath();
          ctx.arc(comet.x, comet.y, 2.6, 0, Math.PI * 2);
          ctx.fill();
        }
        // Its label (distance, name) at the top of the arc.
        const mid = proj[Math.floor(proj.length / 2)];
        if (route.label && mid.visible) {
          ctx.globalAlpha = 1;
          drawTag(ctx, route.label, mid.x, mid.y - 10, color, Math.max(9, fontSize - 1));
        }
      });

      // Major cities as landmarks, once zoomed in (never over the map's own places).
      if (cities.current && v.zoom >= 2.2) {
        // Not over the map's places, nor the distance tags at the middle of the routes.
        const mids = (props.current.routes ?? []).map((r) => greatCircle(r.from, r.to, 2)[1]).map(([lat, lon]) => project(lat, lon));
        const avoid = [...pts.map((p) => project(p.lat, p.lon)), ...mids].filter((q) => q.front > 0).map((q) => ({ x: q.x, y: q.y - 10 }));
        drawCities(
          ctx,
          citiesAtZoom(v.zoom, cities.current),
          (lat, lon) => {
            const q = project(lat, lon);
            return { x: q.x, y: q.y, visible: q.front > 0.05 };
          },
          px,
          px,
          avoid,
          Math.max(9, fontSize - 1),
        );
      }

      // Beacons (the selected one last, on top).
      const sel = props.current.selected ?? -1;
      const order = pts.map((_, i) => i).sort((a, b) => Number(a === sel) - Number(b === sel));
      ctx.font = `600 ${fontSize}px "JetBrains Mono", ui-monospace, Consolas, monospace`;
      for (const i of order) {
        const place = pts[i];
        const p = project(place.lat, place.lon);
        if (p.front <= 0.05) continue;
        const color = cols?.[i] ?? GLOBE_BEACON;
        const isSel = i === sel;
        if (props.current.quiet?.[i] && !isSel) continue;
        const pulse = ((now - started) / 1400 + i * 0.3) % 1;
        ctx.globalAlpha = (1 - pulse) * p.front;
        ctx.strokeStyle = color;
        ctx.lineWidth = isSel ? 1.6 : 1.1;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 3 + pulse * (isSel ? 16 : 10), 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = p.front;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, isSel ? 3.6 : 2.6, 0, Math.PI * 2);
        ctx.fill();
        if (isSel || all) {
          const label = place.name.toUpperCase();
          const right = p.x < cx + R * 0.35;
          const tx = p.x + (right ? 9 : -9);
          const w = ctx.measureText(label).width;
          ctx.globalAlpha = Math.min(1, p.front * 1.4) * (isSel ? 1 : 0.85);
          ctx.fillStyle = 'rgba(5, 8, 4, 0.8)';
          ctx.fillRect(right ? tx - 3 : tx - w - 3, p.y - 7 - fontSize, w + 6, fontSize + 5);
          ctx.fillStyle = isSel ? color : '#e6f5d6';
          ctx.textAlign = right ? 'left' : 'right';
          ctx.fillText(label, tx, p.y - 6);
        }
      }
      ctx.restore();
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      el.removeEventListener('pointerleave', onLeave);
      el.removeEventListener('wheel', onWheel);
    };
  }, [px, interactive]);

  const label = points.map((p) => p.name).join(', ');
  return (
    <canvas
      ref={canvas}
      className={`holo-globe${interactive ? ' holo-globe--interactive' : ''}`}
      style={{ width: px || undefined, height: px || undefined }}
      role="img"
      aria-label={label}
    />
  );
}
