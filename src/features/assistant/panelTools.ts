import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { invoke } from '@tauri-apps/api/core';
import { loadGeometry, placePanel, setPanelGeometry, type Geometry, type PanelPosition, type PanelSize } from '../hud/panelGeometry';

/** Iris arranges the HUD itself: "move the page to the left", "close the news", "bigger". */

export const PANELS = ['conversation', 'knowledge', 'briefing', 'visual'] as const;
export type PanelId = (typeof PANELS)[number];

export interface PanelHooks {
  isVisible: (panel: PanelId) => boolean;
  /** Returns an error message when the panel can't be shown (e.g. nothing built yet). */
  setVisible: (panel: PanelId, visible: boolean) => string | null;
}

const POSITIONS = ['left', 'right', 'center', 'top', 'bottom', 'top-left', 'top-right', 'bottom-left', 'bottom-right'] as const;
const SIZES = ['small', 'medium', 'large', 'full'] as const;

/** Current box of a panel: on screen if mounted, else its remembered or a default one. */
function currentGeometry(panel: PanelId, W: number, H: number): Geometry {
  const el = document.querySelector(`[data-panel="${panel}"]`);
  const root = document.querySelector('.hud')?.getBoundingClientRect() ?? { left: 0, top: 0 };
  if (el) {
    const r = el.getBoundingClientRect();
    return { x: r.left - root.left, y: r.top - root.top, w: r.width, h: r.height };
  }
  return loadGeometry(panel) ?? { x: W * 0.25, y: 68, w: W * 0.4, h: H * 0.5 };
}

export function createPanelTools(hooks: PanelHooks): ToolSet {
  return {
    control_window: tool({
      description:
        'Show, hide or move your own windows: "main" (the full interface) or "mini" (the small always-on-top window above the tray icon, shown while the interface is hidden). Use it when the user asks to see your interface ("montre-toi", "affiche ton interface"), to hide it ("cache-toi"), to hide / show the mini window, or to move a window ("mets-toi en haut à gauche").',
      inputSchema: z.object({
        window: z.enum(['main', 'mini', 'auto']).describe('auto = the interface if it is on screen, else the mini window'),
        action: z.enum(['show', 'hide', 'move']),
        position: z.enum(POSITIONS).optional().describe('For move'),
      }),
      execute: async ({ window, action, position }) => ({
        done: true,
        state: await invoke<string>('window_control', { target: window, action, position: position ?? null }),
      }),
    }),


    arrange_panels: tool({
      description:
        'Rearrange the HUD: move, resize, hide or show its panels. Panels: "conversation" (chat log), "knowledge" (knowledge graph), "briefing" (info cards: news, weather, web results…), "visual" (what you built: pages, charts, documents), or "all".',
      inputSchema: z.object({
        actions: z
          .array(
            z.object({
              panel: z.enum([...PANELS, 'all']),
              action: z
                .enum(['show', 'hide', 'move', 'resize', 'reset'])
                .describe('move/resize: use position and/or size. reset: back to the default layout (and shown).'),
              position: z.enum(POSITIONS).optional().describe('Where to put the panel'),
              size: z.enum(SIZES).optional().describe('full = the whole free area of the screen'),
            }),
          )
          .min(1)
          .describe('Applied in order'),
      }),
      execute: async ({ actions }) => {
        const root = document.querySelector('.hud')?.getBoundingClientRect();
        const W = root?.width ?? window.innerWidth;
        const H = root?.height ?? window.innerHeight;
        const problems: string[] = [];

        for (const a of actions) {
          const targets: readonly PanelId[] = a.panel === 'all' ? PANELS : [a.panel];
          for (const panel of targets) {
            if (a.action === 'hide') {
              hooks.setVisible(panel, false);
              continue;
            }
            // Every other action also brings the panel on screen.
            if (!hooks.isVisible(panel)) {
              const error = hooks.setVisible(panel, true);
              if (error) {
                if (a.panel !== 'all') problems.push(`${panel}: ${error}`);
                continue;
              }
            }
            if (a.action === 'reset') setPanelGeometry(panel, null);
            if (a.action === 'move' || a.action === 'resize') {
              const next = placePanel(currentGeometry(panel, W, H), W, H, a.position as PanelPosition | undefined, a.size as PanelSize | undefined);
              setPanelGeometry(panel, next);
            }
          }
        }
        return {
          done: problems.length === 0,
          problems: problems.length ? problems : undefined,
          panels: Object.fromEntries(PANELS.map((p) => [p, hooks.isVisible(p) ? 'visible' : 'hidden'])),
        };
      },
    }),
  };
}
