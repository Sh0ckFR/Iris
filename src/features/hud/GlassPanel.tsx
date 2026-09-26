import { useEffect, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react';
import { motion } from 'framer-motion';
import { GripIcon } from './icons';
import { t } from '../../i18n';
import { applyDelta, clampGeometry, EDGES, loadGeometry, onGeometryChange, storeGeometry, type Edge, type Geometry } from './panelGeometry';

/**
 * Stacking order of the panels, front-most last: like desktop windows, the panel you touch comes
 * to the front. Panels take z-index 2 + their rank, below the top bar and the dock (see HUD.css).
 */
let stack: string[] = [];
const stackListeners = new Set<() => void>();

function bringToFront(id: string) {
  if (stack[stack.length - 1] === id) return;
  stack = [...stack.filter((p) => p !== id), id];
  stackListeners.forEach((l) => l());
}

function useStackRank(id: string): number {
  const rank = () => Math.max(0, stack.indexOf(id));
  return useSyncExternalStore((l) => {
    stackListeners.add(l);
    return () => stackListeners.delete(l);
  }, rank);
}

interface GlassPanelProps {
  /** Stable id: the panel's position and size are remembered under it. */
  id: string;
  title: string;
  className?: string;
  /** Element the panel lives in (positions are relative to it and clamped inside it). */
  bounds: RefObject<HTMLElement | null>;
  actions?: ReactNode;
  delay?: number;
  children: ReactNode;
}

/**
 * Glassmorphism panel: drag it by its header, resize it from any side or corner. Until the user
 * moves it, the panel keeps its default CSS placement; afterwards its geometry is explicit and
 * remembered. Double-click the header to restore the default layout.
 */
export function GlassPanel({ id, title, className = '', bounds, actions, delay = 0, children }: GlassPanelProps) {
  const panel = useRef<HTMLElement>(null);
  const [geo, setGeo] = useState<Geometry | null>(() => loadGeometry(id));
  const [interacting, setInteracting] = useState<'move' | 'resize' | null>(null);
  /** Slides to its new place when Iris rearranges the HUD (not when dragged by hand). */
  const [gliding, setGliding] = useState(false);
  const rank = useStackRank(id);
  // A panel that appears (a new visual, a briefing) opens in front of the others.
  useEffect(() => bringToFront(id), [id]);

  useEffect(() => {
    let timer = 0;
    const off = onGeometryChange((changed) => {
      if (changed !== id) return;
      setGliding(true);
      const target = loadGeometry(id);
      const el = panel.current;
      const root = bounds.current?.getBoundingClientRect();
      if (target && el && root) {
        // From the CSS default layout (right/bottom anchors), pin the current box first so the
        // move can be animated, then glide on the next frame.
        const r = el.getBoundingClientRect();
        setGeo((g) => g ?? { x: r.left - root.left, y: r.top - root.top, w: r.width, h: r.height });
        requestAnimationFrame(() => requestAnimationFrame(() => setGeo(target)));
      } else {
        setGeo(target);
      }
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setGliding(false), 700);
    });
    return () => {
      off();
      window.clearTimeout(timer);
    };
  }, [id, bounds]);

  // Keep the panel inside the window when the window shrinks.
  useEffect(() => {
    const onResize = () => {
      const root = bounds.current?.getBoundingClientRect();
      if (!root) return;
      setGeo((g) => (g ? clampGeometry(g, root.width, root.height) : g));
    };
    window.addEventListener('resize', onResize);
    onResize();
    return () => window.removeEventListener('resize', onResize);
  }, [bounds]);

  const begin = (mode: 'move' | Edge) => (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0 || !panel.current || !bounds.current) return;
    e.preventDefault();
    e.stopPropagation();
    const root = bounds.current.getBoundingClientRect();
    const rect = panel.current.getBoundingClientRect();
    const start: Geometry = { x: rect.left - root.left, y: rect.top - root.top, w: rect.width, h: rect.height };
    const origin = { x: e.clientX, y: e.clientY };
    let latest = start;
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    setInteracting(mode === 'move' ? 'move' : 'resize');

    const onMove = (ev: PointerEvent) => {
      latest = clampGeometry(applyDelta(start, mode, ev.clientX - origin.x, ev.clientY - origin.y), root.width, root.height);
      setGeo(latest);
    };
    const onEnd = () => {
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onEnd);
      target.removeEventListener('pointercancel', onEnd);
      setInteracting(null);
      if (latest !== start) storeGeometry(id, latest);
    };
    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onEnd);
    target.addEventListener('pointercancel', onEnd);
  };

  const reset = () => {
    setGeo(null);
    storeGeometry(id, null);
  };

  const style = {
    zIndex: 2 + rank,
    ...(geo && { left: geo.x, top: geo.y, width: geo.w, height: geo.h, right: 'auto', bottom: 'auto', minHeight: 0 }),
  };

  return (
    <motion.section
      ref={panel}
      data-panel={id}
      className={`hud-panel ${className}${interacting ? ` hud-panel--${interacting}` : ''}${gliding ? ' hud-panel--glide' : ''}`}
      style={style}
      // Capture: a click anywhere in the panel (header, content, resize edge) raises it.
      onPointerDownCapture={() => bringToFront(id)}
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.2 } }}
      transition={{ delay, duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
    >
      <header className="hud-panel-header" onPointerDown={begin('move')} onDoubleClick={reset} title={t().hud.panelHeaderHint}>
        <GripIcon className="hud-panel-grip" width={14} height={14} />
        <h2>{title}</h2>
        <div className="hud-panel-actions" onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
          {actions}
        </div>
      </header>
      <div className="hud-panel-body">{children}</div>
      {EDGES.map((edge) => (
        <div key={edge} className={`hud-resize hud-resize--${edge}`} onPointerDown={begin(edge)} aria-hidden />
      ))}
    </motion.section>
  );
}
