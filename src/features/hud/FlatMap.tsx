import { useEffect, useRef, useState } from 'react';
import type { GeoPoint } from '../assistant/tools';
import { GLOBE_ACCENT, GLOBE_BEACON, MAX_ZOOM, isLand } from './HoloGlobe';
import { countryAt } from './countries';
import { drawArrow, drawTag, greatCircle, loadOutlines, NO_DATA, type Outline, type Route } from './geo';
import { citiesAtZoom, drawCities, loadCities, type City } from './cities';

/**
 * The flat counterpart of the globe: a dotted world map (equirectangular, 2° land cells from the
 * same built-in mask) with coastlines, borders and beacons. Wheel to zoom (or Iris, with
 * focus/zoom), drag to pan, click a beacon to select it.
 */

const LAND: [lat: number, lon: number][] = (() => {
  const dots: [number, number][] = [];
  for (let lat = 83; lat >= -57; lat -= 2) for (let lon = -179; lon < 180; lon += 2) if (isLand(lat, lon)) dots.push([lat, lon]);
  return dots;
})();

/** Country of each land dot (heat mode), computed the first time it is needed. */
let landCountries: Int16Array | null = null;
const landCountry = (i: number) => (landCountries ??= Int16Array.from(LAND, ([lat, lon]) => countryAt(lat, lon)))[i];

/** Shown latitudes: the inhabited world (Antarctica would take a sixth of the height). */
const TOP = 84;
const BOTTOM = -58;
const MID_LAT = (TOP + BOTTOM) / 2;

type Hit = { lat: number; lon: number; x: number; y: number } | null;

export function FlatMap({
  points,
  selected,
  onSelect,
  colors,
  routes,
  dotColor,
  onHover,
  quiet,
  focus,
  zoom,
  cameraKey,
}: {
  points: GeoPoint[];
  selected: number | null;
  onSelect?: (index: number) => void;
  colors?: string[];
  routes?: Route[];
  dotColor?: (country: number) => string | null;
  onHover?: (hit: Hit) => void;
  quiet?: boolean[];
  /** Camera: the place to centre and how close (1 = whole world … 10). */
  focus?: GeoPoint | null;
  zoom?: number;
  cameraKey?: number;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const props = useRef({ points, selected, colors, routes, dotColor, onHover, quiet });
  props.current = { points, selected, colors, routes, dotColor, onHover, quiet };
  /** View centre and zoom, eased towards their targets. */
  const view = useRef({ lon: 0, lat: MID_LAT, z: 1, tLon: 0, tLat: MID_LAT, tZ: 1 });
  const lines = useRef<Outline[] | null>(null);
  const cities = useRef<City[] | null>(null);

  useEffect(() => {
    void loadOutlines().then((o) => (lines.current = o));
    void loadCities().then((c) => (cities.current = c));
  }, []);

  // A camera order: centre on the place, at that zoom.
  useEffect(() => {
    const v = view.current;
    if (focus) {
      v.tLon = focus.lon;
      v.tLat = focus.lat;
    }
    if (zoom !== undefined) v.tZ = Math.max(1, Math.min(MAX_ZOOM, zoom));
  }, [focus?.lat, focus?.lon, zoom, cameraKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const parent = canvas.current?.parentElement;
    if (!parent) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      // Keep the map's proportions inside the available box.
      const ratio = 360 / (TOP - BOTTOM);
      const w = Math.floor(Math.min(width, height * ratio));
      setBox({ w, h: Math.floor(w / ratio) });
    });
    observer.observe(parent);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext('2d');
    if (!el || !ctx || box.w === 0) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    el.width = box.w * dpr;
    el.height = box.h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const v = view.current;
    const kx = () => (box.w * v.z) / 360; // px per degree (the same both ways)
    /** Keeps the view over the map (no empty space beyond its edges). */
    const clampView = (lon: number, lat: number, z: number) => {
      const halfLon = 180 / z;
      const halfLat = (TOP - BOTTOM) / 2 / z;
      return {
        lon: Math.max(-180 + halfLon, Math.min(180 - halfLon, lon)),
        lat: Math.max(BOTTOM + halfLat, Math.min(TOP - halfLat, lat)),
      };
    };
    const x = (lon: number) => box.w / 2 + (lon - v.lon) * kx();
    const y = (lat: number) => box.h / 2 - (lat - v.lat) * kx();
    const toGeo = (px: number, py: number) => ({ lon: v.lon + (px - box.w / 2) / kx(), lat: v.lat - (py - box.h / 2) / kx() });
    const fontSize = Math.max(9, Math.min(12, box.w / 70));
    const started = performance.now();
    let last = started;
    let raf = 0;

    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const ease = Math.min(1, dt * 3);
      v.z += (v.tZ - v.z) * ease;
      const target = clampView(v.tLon, v.tLat, v.z);
      v.lon += (target.lon - v.lon) * ease;
      v.lat += (target.lat - v.lat) * ease;

      const { points: pts, selected: sel, colors: cols, routes: paths, dotColor: heat } = props.current;
      ctx.clearRect(0, 0, box.w, box.h);
      ctx.fillStyle = GLOBE_ACCENT;
      // Graticule every 30° (every 10° when zoomed in).
      const step = v.z >= 3 ? 10 : 30;
      ctx.globalAlpha = 0.1;
      for (let lon = -180 + step; lon < 180; lon += step) ctx.fillRect(x(lon), 0, 1, box.h);
      for (let lat = -60; lat <= 80; lat += step) ctx.fillRect(0, y(lat), box.w, 1);

      // Land dots: they fade as the outlines take over when zoomed in.
      const s = Math.max(1, (box.w / 180) * 0.55 * Math.min(v.z, 1.8));
      const fade = Math.max(0.12, 1 - (v.z - 1) * 0.2);
      ctx.globalAlpha = 0.55 * fade;
      for (let k = 0; k < LAND.length; k++) {
        const [lat, lon] = LAND[k];
        const px = x(lon);
        const py = y(lat);
        if (px < -s || py < -s || px > box.w + s || py > box.h + s) continue;
        if (heat) {
          const country = landCountry(k);
          const c = country >= 0 ? heat(country) : null;
          ctx.fillStyle = c || NO_DATA;
          ctx.globalAlpha = (c ? 0.95 : 0.5) * Math.max(0.6, fade);
        }
        ctx.fillRect(px - s / 2, py - s / 2, s, s);
      }
      ctx.fillStyle = GLOBE_ACCENT;

      // Coastlines and borders.
      if (lines.current) {
        const coastAlpha = Math.min(0.9, 0.35 + 0.12 * v.z);
        ctx.lineWidth = v.z > 2 ? 1.2 : 0.8;
        ctx.strokeStyle = GLOBE_ACCENT;
        for (const line of lines.current) {
          ctx.globalAlpha = line.border ? coastAlpha * 0.55 : coastAlpha;
          ctx.beginPath();
          for (let k = 0; k < line.points.length; k += 2) {
            const px = x(line.points[k]);
            const py = y(line.points[k + 1]);
            // A jump across the date line is not drawn across the map.
            if (k === 0 || Math.abs(line.points[k] - line.points[k - 2]) > 180) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
          }
          ctx.stroke();
        }
      }

      // Scan line sweeping across.
      const t = ((now - started) / 4000) % 1;
      ctx.globalAlpha = 0.25 * Math.sin(t * Math.PI);
      ctx.fillStyle = GLOBE_ACCENT;
      ctx.fillRect(t * box.w, 0, 1.5, box.h);

      // Routes: great circles (split where they cross the map's edge), a comet, an arrowhead, a label.
      (paths ?? []).forEach((route, r) => {
        const geo = greatCircle(route.from, route.to, 64);
        const line = geo.map(([lat, lon]) => [x(lon), y(lat)] as const);
        const color = route.color ?? GLOBE_BEACON;
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = 1.6;
        ctx.globalAlpha = 0.85;
        ctx.setLineDash([6, 5]);
        ctx.lineDashOffset = -((now - started) / 40) % 11;
        ctx.beginPath();
        line.forEach(([px, py], i) => (i > 0 && Math.abs(geo[i][1] - geo[i - 1][1]) < 180 ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
        ctx.stroke();
        ctx.setLineDash([]);
        const [ex, ey] = line[line.length - 1];
        const [bx, by] = line[line.length - 3];
        if (Math.abs(geo[geo.length - 1][1] - geo[geo.length - 3][1]) < 180) drawArrow(ctx, ex, ey, ex - bx, ey - by);
        const tc = ((now - started) / 2600 + r * 0.23) % 1;
        const [cxp, cyp] = line[Math.round(tc * (line.length - 1))];
        ctx.globalAlpha = Math.sin(tc * Math.PI);
        ctx.beginPath();
        ctx.arc(cxp, cyp, 2.6, 0, Math.PI * 2);
        ctx.fill();
        if (route.label) {
          const [mx, my] = line[Math.floor(line.length / 2)];
          ctx.globalAlpha = 1;
          drawTag(ctx, route.label, mx, my - 10, color, Math.max(9, fontSize - 1));
        }
      });

      // Major cities as landmarks, once zoomed in (never over the map's own places).
      if (cities.current && v.z >= 2.2) {
        // Not over the map's places, nor the distance tags at the middle of the routes.
        const mids = (paths ?? []).map((r) => greatCircle(r.from, r.to, 2)[1]).map(([lat, lon]) => ({ x: x(lon), y: y(lat) - 10 }));
        const avoid = [...pts.map((p) => ({ x: x(p.lon), y: y(p.lat) })), ...mids];
        drawCities(ctx, citiesAtZoom(v.z, cities.current), (lat, lon) => ({ x: x(lon), y: y(lat), visible: true }), box.w, box.h, avoid, Math.max(9, fontSize - 1));
      }

      ctx.font = `600 ${fontSize}px "JetBrains Mono", ui-monospace, Consolas, monospace`;
      const order = pts.map((_, i) => i).sort((a, b) => Number(a === sel) - Number(b === sel));
      for (const i of order) {
        const p = pts[i];
        const px = x(p.lon);
        const py = y(Math.max(BOTTOM, Math.min(TOP, p.lat)));
        if (px < -20 || py < -20 || px > box.w + 20 || py > box.h + 20) continue;
        const color = cols?.[i] ?? GLOBE_BEACON;
        const isSel = i === sel;
        if (props.current.quiet?.[i] && !isSel) continue;
        const pulse = ((now - started) / 1400 + i * 0.3) % 1;
        ctx.globalAlpha = 1 - pulse;
        ctx.strokeStyle = color;
        ctx.lineWidth = isSel ? 1.6 : 1.1;
        ctx.beginPath();
        ctx.arc(px, py, 3 + pulse * (isSel ? 16 : 10), 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(px, py, isSel ? 3.6 : 2.6, 0, Math.PI * 2);
        ctx.fill();
        if (isSel || pts.length <= 12 || v.z >= 3) {
          const label = p.name.toUpperCase();
          const right = px < box.w * 0.75;
          const w = ctx.measureText(label).width;
          const tx = px + (right ? 9 : -9);
          ctx.globalAlpha = isSel ? 1 : 0.85;
          ctx.fillStyle = 'rgba(5, 8, 4, 0.8)';
          ctx.fillRect(right ? tx - 3 : tx - w - 3, py - 7 - fontSize, w + 6, fontSize + 5);
          ctx.fillStyle = isSel ? color : '#e6f5d6';
          ctx.textAlign = right ? 'left' : 'right';
          ctx.fillText(label, tx, py - 6);
        }
      }
      ctx.globalAlpha = 1;
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    // ---- interaction: wheel zoom (towards the mouse), drag to pan, click a beacon, hover
    let drag: { x: number; y: number; moved: boolean } | null = null;
    const local = (e: MouseEvent) => {
      const rect = el.getBoundingClientRect();
      return { mx: e.clientX - rect.left, my: e.clientY - rect.top };
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { mx, my } = local(e);
      const at = toGeo(mx, my);
      const z = Math.max(1, Math.min(MAX_ZOOM, v.tZ * (e.deltaY < 0 ? 1.2 : 1 / 1.2)));
      // The point under the mouse stays under the mouse.
      v.tLon = at.lon - (mx - box.w / 2) / ((box.w * z) / 360);
      v.tLat = at.lat + (my - box.h / 2) / ((box.w * z) / 360);
      v.tZ = z;
    };
    const onDown = (e: PointerEvent) => {
      drag = { x: e.clientX, y: e.clientY, moved: false };
      el.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      const { mx, my } = local(e);
      if (!drag) {
        const at = toGeo(mx, my);
        props.current.onHover?.({ ...at, x: mx, y: my });
        return;
      }
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      if (!drag.moved) return;
      const c = clampView(v.lon - dx / kx(), v.lat + dy / kx(), v.z);
      v.lon = v.tLon = c.lon;
      v.lat = v.tLat = c.lat;
      drag.x = e.clientX;
      drag.y = e.clientY;
    };
    const onUp = (e: PointerEvent) => {
      const wasClick = drag && !drag.moved;
      drag = null;
      if (!wasClick) return;
      const { mx, my } = local(e);
      let best = -1;
      let bestD = 14;
      props.current.points.forEach((p, i) => {
        const d = Math.hypot(x(p.lon) - mx, y(p.lat) - my);
        if (d < bestD) {
          best = i;
          bestD = d;
        }
      });
      if (best >= 0) onSelect?.(best);
    };
    const onLeave = () => props.current.onHover?.(null);
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
    el.addEventListener('pointerleave', onLeave);
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      el.removeEventListener('pointerleave', onLeave);
    };
  }, [box, onSelect]);

  return (
    <canvas
      ref={canvas}
      className="holo-map"
      style={{ width: box.w || undefined, height: box.h || undefined }}
      role="img"
      aria-label={points.map((p) => p.name).join(', ')}
    />
  );
}
