/** Position and size of a HUD panel in px, relative to its container. */
export interface Geometry {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
export const EDGES: Edge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

export const MIN_W = 240;
export const MIN_H = 160;

const storageKey = (id: string) => `iris.panel.${id}.geometry`;

export function loadGeometry(id: string): Geometry | null {
  try {
    const raw = localStorage.getItem(storageKey(id));
    const g = raw ? (JSON.parse(raw) as Geometry) : null;
    return g && g.w >= MIN_W && g.h >= MIN_H ? g : null;
  } catch {
    return null;
  }
}

export function storeGeometry(id: string, g: Geometry | null) {
  try {
    if (g) localStorage.setItem(storageKey(id), JSON.stringify(g));
    else localStorage.removeItem(storageKey(id));
  } catch {
    // Non-fatal: the layout just won't be remembered.
  }
}

/** Keeps a panel fully inside its container, at least MIN_W × MIN_H. */
export function clampGeometry(g: Geometry, W: number, H: number): Geometry {
  const w = Math.min(Math.max(g.w, MIN_W), W);
  const h = Math.min(Math.max(g.h, MIN_H), H);
  return {
    w: Math.round(w),
    h: Math.round(h),
    x: Math.round(Math.min(Math.max(g.x, 0), W - w)),
    y: Math.round(Math.min(Math.max(g.y, 0), H - h)),
  };
}

// ------------------------------------------------------------------ layout driven by Iris

const listeners = new Set<(id: string) => void>();

/** Mounted panels re-read their geometry when Iris moves them (arrange_panels). */
export function onGeometryChange(fn: (id: string) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Stores a geometry (null = default layout) and tells the panel; a hidden panel gets it when shown. */
export function setPanelGeometry(id: string, g: Geometry | null) {
  storeGeometry(id, g);
  listeners.forEach((fn) => fn(id));
}

export type PanelPosition = 'left' | 'right' | 'center' | 'top' | 'bottom' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
export type PanelSize = 'small' | 'medium' | 'large' | 'full';

/** Share of the free area (between the top bar and the control dock) for each size. */
const SIZES: Record<PanelSize, [w: number, h: number]> = {
  small: [0.3, 0.45],
  medium: [0.46, 0.7],
  large: [0.7, 1],
  full: [1, 1],
};

/**
 * Where a panel goes for a named position and/or size, in a W × H window. Unspecified parts are
 * kept: a size alone keeps the panel's place (clamped), a position alone keeps its size.
 */
export function placePanel(current: Geometry, W: number, H: number, position?: PanelPosition, size?: PanelSize): Geometry {
  const top = 68;
  const bottom = 150;
  const area = H - top - bottom >= MIN_H * 1.5 ? { x: 16, y: top, w: W - 32, h: H - top - bottom } : { x: 8, y: 8, w: W - 16, h: H - 16 };
  let { x, y, w, h } = current;
  if (size) {
    const [fw, fh] = SIZES[size];
    w = area.w * fw;
    h = area.h * fh;
  }
  w = Math.min(Math.max(w, MIN_W), area.w);
  h = Math.min(Math.max(h, MIN_H), area.h);
  if (size === 'full') return clampGeometry({ x: area.x, y: area.y, w, h }, W, H);
  if (position) {
    const horizontal = position.includes('left') ? 'left' : position.includes('right') ? 'right' : 'center';
    const vertical = position.includes('top') ? 'top' : position.includes('bottom') ? 'bottom' : 'middle';
    x = horizontal === 'left' ? area.x : horizontal === 'right' ? area.x + area.w - w : area.x + (area.w - w) / 2;
    y = vertical === 'top' ? area.y : vertical === 'bottom' ? area.y + area.h - h : area.y + (area.h - h) / 2;
  } else {
    // Resized in place: keep its centre where it was, inside the free area.
    x = Math.min(Math.max(current.x + (current.w - w) / 2, area.x), area.x + area.w - w);
    y = Math.min(Math.max(current.y + (current.h - h) / 2, area.y), area.y + area.h - h);
  }
  return clampGeometry({ x, y, w, h }, W, H);
}

/** New geometry for a drag (`move`) or a resize from one edge/corner. */
export function applyDelta(start: Geometry, mode: 'move' | Edge, dx: number, dy: number): Geometry {
  if (mode === 'move') return { ...start, x: start.x + dx, y: start.y + dy };
  let { x, y, w, h } = start;
  if (mode.includes('e')) w = start.w + dx;
  if (mode.includes('s')) h = start.h + dy;
  if (mode.includes('w')) {
    w = Math.max(MIN_W, start.w - dx);
    x = start.x + start.w - w; // the right edge stays put
  }
  if (mode.includes('n')) {
    h = Math.max(MIN_H, start.h - dy);
    y = start.y + start.h - h; // the bottom edge stays put
  }
  return { x, y, w, h };
}
