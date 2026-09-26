import { useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { WidgetSpec } from '../features/assistant/widgetTools';
import { t } from '../i18n';

/**
 * Pinned dashboards: widgets kept on the HUD across restarts ("Iris, garde ce tableau de bord"),
 * grouped in named dashboards ("mon écran du matin") that can be shown again by voice. Live
 * widgets keep refreshing by themselves: once pinned, a dashboard costs no tokens at all.
 * Kept on disk (`<app data>/memory/dashboards.json`), with which one is open.
 */

export interface PinnedWidget {
  id: string;
  spec: WidgetSpec;
  pinnedAt: number;
}

export interface Dashboard {
  id: string;
  name: string;
  widgets: PinnedWidget[];
}

interface State {
  dashboards: Dashboard[];
  /** The dashboard on screen (null = panel closed). */
  open: string | null;
}

const FILE = 'dashboards';
let state: State = { dashboards: [], open: null };
let loaded: Promise<void> | null = null;
const listeners = new Set<() => void>();

export const defaultDashboardName = () => t().dashboard.defaultName;

const normalize = (s: string) =>
  s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function set(next: State) {
  state = next;
  listeners.forEach((l) => l());
  invoke('memory_write', { name: FILE, content: JSON.stringify(state) }).catch((error) => console.warn('[iris:dashboards] could not save', error));
}

/** A dashboard by name ("écran du matin", "matin", "mon tableau de bord"); the first one without a name. */
export function findDashboard(name?: string): Dashboard | null {
  if (!name?.trim()) return state.dashboards[0] ?? null;
  const n = normalize(name).replace(/^(mon|ma|mes|le|la|les|l|my|the) /, '');
  return (
    state.dashboards.find((d) => normalize(d.name) === n) ??
    state.dashboards.find((d) => normalize(d.name).includes(n) || n.includes(normalize(d.name))) ??
    null
  );
}

export const dashboardStore = {
  load(): Promise<void> {
    loaded ??= invoke<string | null>('memory_read', { name: FILE })
      .then((raw) => {
        if (raw) state = { dashboards: [], open: null, ...(JSON.parse(raw) as Partial<State>) };
        listeners.forEach((l) => l());
      })
      .catch((error) => console.warn('[iris:dashboards] could not read', error));
    return loaded;
  },

  /** Pins a widget (a new dashboard is made for a new name) and shows that dashboard. */
  pin(spec: WidgetSpec, name?: string): Dashboard {
    const wanted = name?.trim() || defaultDashboardName();
    const existing = findDashboard(wanted);
    const widget: PinnedWidget = { id: uid(), spec, pinnedAt: Date.now() };
    const dashboard = existing
      ? { ...existing, widgets: [...existing.widgets.filter((w) => w.spec.title !== spec.title), widget] }
      : { id: uid(), name: wanted.charAt(0).toUpperCase() + wanted.slice(1), widgets: [widget] };
    set({
      dashboards: existing ? state.dashboards.map((d) => (d.id === existing.id ? dashboard : d)) : [...state.dashboards, dashboard],
      open: dashboard.id,
    });
    return dashboard;
  },

  unpin(dashboardId: string, widgetId: string) {
    set({
      ...state,
      dashboards: state.dashboards
        .map((d) => (d.id === dashboardId ? { ...d, widgets: d.widgets.filter((w) => w.id !== widgetId) } : d))
        .filter((d) => d.widgets.length > 0),
      open: state.open,
    });
    if (!state.dashboards.some((d) => d.id === state.open)) set({ ...state, open: state.dashboards[0]?.id ?? null });
  },

  remove(dashboardId: string) {
    const dashboards = state.dashboards.filter((d) => d.id !== dashboardId);
    set({ dashboards, open: state.open === dashboardId ? (dashboards[0]?.id ?? null) : state.open });
  },

  open(id: string | null) {
    set({ ...state, open: id });
  },

  state: () => state,

  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

export function useDashboards(): State {
  return useSyncExternalStore(dashboardStore.subscribe, () => state);
}
