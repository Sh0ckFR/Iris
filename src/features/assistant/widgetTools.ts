import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import type { Language } from '../../lib/settings';
import { geocode } from './geocode';
import { country, findCountry } from '../hud/countries';
import { distanceKm } from '../hud/geo';
import { dashboardStore, findDashboard } from '../../lib/dashboards';
import { resolveLang, type GeoPoint, type ToolHooks, type VisualBriefing } from './tools';

/**
 * Ready-made widgets for showing data: map / globe, chart, table, key figures, timeline and
 * cards. The model only sends the data (a few dozen tokens) and the HUD renders it at once with
 * its own components, instead of writing a whole web page with create_visual (thousands of
 * output tokens and seconds of streaming). create_visual stays for things the user asks to create.
 */

export type WidgetKind = 'map' | 'chart' | 'table' | 'stats' | 'timeline' | 'cards';
export type ChartType = 'line' | 'area' | 'bar' | 'pie';

export interface WidgetItem {
  /** Name, title or place. */
  label: string;
  detail?: string;
  value?: number;
  unit?: string;
  /** Change in % (key figures). */
  change?: number;
  /** Group: gives the colour and the tag. */
  category?: string;
  /** Date or time (timeline), as written by the model ("2026-09-25", "14 h", "mars 2026"). */
  date?: string;
  url?: string;
  /** Place to put on the map when the label is not one ("Discours du pape" → "Paris"). */
  place?: string;
  coords?: GeoPoint;
  /** Kept up to date by the widget itself (no AI call): a quote or the weather of `query`. */
  live?: LiveSource;
  /** What `live` follows (default: the label): "bitcoin", "EUR USD", "Lyon"… */
  query?: string;
  /** Heat mode: the country of the label (index in hud/countries), when it is one. */
  country?: number;
}

export type LiveSource = 'quote' | 'weather';

/** An arrow between two places (a flight, a leg of a trip, a flow). */
export interface WidgetRoute {
  from: string;
  to: string;
  label?: string;
  fromCoords?: GeoPoint;
  toCoords?: GeoPoint;
}

export interface WidgetSpec {
  kind: WidgetKind;
  title: string;
  subtitle?: string;
  items: WidgetItem[];
  chartType?: ChartType;
  /** Chart x-axis labels (dates, months, categories). */
  labels?: string[];
  series?: { name: string; values: number[] }[];
  unit?: string;
  columns?: string[];
  rows?: string[][];
  view?: 'globe' | 'flat';
  /** `heat`: countries coloured by their value (choropleth) instead of beacons. */
  mapMode?: 'markers' | 'heat';
  routes?: WidgetRoute[];
  /** Join the items with arrows in their order (an itinerary). */
  connect?: boolean;
  /** Camera: the place to look at and how close (1 = whole world … 10), set by the model. */
  focus?: string;
  focusCoords?: GeoPoint;
  zoom?: number;
  /** When the camera was last ordered (the widget flies there again only then). */
  cameraAt?: number;
  /** Guided tour: the map flies from item to item, following the spoken reply (or by itself). */
  tour?: boolean;
  /** Places no geocoder found (map). */
  notFound?: string[];
  source?: string;
}

const MAX_ITEMS = 40;

let seq = 0;
const widgetId = () => `w-${Date.now().toString(36)}-${(seq++).toString(36)}`;

const itemSchema = z.object({
  label: z.string().describe('Name, title or place name'),
  detail: z.string().optional().describe('One or two short sentences'),
  value: z.number().optional(),
  unit: z.string().optional(),
  change: z.number().optional().describe('stats: change in %'),
  category: z.string().optional().describe('Group or tag (e.g. the country, "positif"); items of a group share a colour'),
  date: z.string().optional().describe('timeline: date or time'),
  url: z.string().optional(),
  place: z.string().optional().describe('map: place name to locate when the label is not a place (e.g. label "Discours du pape", place "Paris")'),
  lat: z.number().optional().describe('map: only for a point with no name'),
  lon: z.number().optional(),
  live: z
    .enum(['quote', 'weather'])
    .optional()
    .describe('stats/cards: keep this figure up to date on screen by itself — "quote" (share, index, crypto, currency) or "weather" (city)'),
  query: z.string().optional().describe('With live: what to follow when the label is not it, e.g. "BTC-EUR", "Lyon"'),
});

/** Adds the new items to the previous widget (same label = replaced), for "ajoute Berlin". */
export function merge(previous: WidgetSpec, next: WidgetSpec): WidgetSpec {
  const byLabel = new Map(previous.items.map((i) => [i.label.toLowerCase(), i]));
  next.items.forEach((i) => byLabel.set(i.label.toLowerCase(), i));
  const series = new Map((previous.series ?? []).map((s) => [s.name, s]));
  (next.series ?? []).forEach((s) => series.set(s.name, s));
  return {
    ...previous,
    ...Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined && !(Array.isArray(v) && v.length === 0))),
    items: [...byLabel.values()].slice(0, MAX_ITEMS),
    series: series.size ? [...series.values()] : undefined,
    rows: next.rows?.length ? [...(previous.rows ?? []), ...next.rows] : previous.rows,
    routes: next.routes?.length ? [...(previous.routes ?? []), ...next.routes] : previous.routes,
    notFound: next.notFound,
  };
}

/** The map's legs and their great-circle distances, plus the total of an itinerary. */
export function routeDistances(spec: WidgetSpec): string[] {
  const legs: { from: string; to: string; a?: GeoPoint; b?: GeoPoint; leg?: boolean }[] = (spec.routes ?? []).map((r) => ({ from: r.from, to: r.to, a: r.fromCoords, b: r.toCoords }));
  if (spec.connect) {
    const placed = spec.items.filter((i) => i.coords);
    placed.slice(1).forEach((item, i) => legs.push({ from: placed[i].place ?? placed[i].label, to: item.place ?? item.label, a: placed[i].coords, b: item.coords, leg: true }));
  }
  const known = legs.filter((l) => l.a && l.b).map((l) => ({ ...l, km: distanceKm(l.a!, l.b!) }));
  const lines = known.map((l) => `${l.from} → ${l.to}: ${Math.round(l.km)} km`);
  // The itinerary's total (separate routes are not part of it).
  const itinerary = known.filter((l) => l.leg);
  if (itinerary.length > 1) lines.push(`Itinerary total: ${Math.round(itinerary.reduce((n, l) => n + l.km, 0))} km`);
  return lines;
}

export function createWidgetTools(
  hooks: ToolHooks & { lastVisual: () => VisualBriefing | null },
  defaultLanguage: Language,
): ToolSet {
  return {
    show_data: tool({
      description:
        'Show data on screen in a ready-made widget, instantly and for a few tokens: ' +
        'map (places on a globe or flat map: news by country, a trip, offices, cities…; give place NAMES, they are located for you), ' +
        'chart (line/area for change over time, bar to compare, pie for shares of a whole), ' +
        'table (rows and columns), stats (key figures with their change), timeline (dated events), cards (a list of items with a title and details). ' +
        'A map can also draw arrows between places (routes, or connect for an itinerary) and colour countries by value (map_mode "heat"). ' +
        'Stats and cards items can be live (quotes, weather): the widget then refreshes them by itself, for free. ' +
        'Use it whenever you display information, instead of create_visual. With revise_previous, the items are added to the widget on screen.',
      inputSchema: z.object({
        widget: z.enum(['map', 'chart', 'table', 'stats', 'timeline', 'cards']),
        title: z.string(),
        subtitle: z.string().optional(),
        items: z.array(itemSchema).optional().describe('map, stats, timeline, cards; also a single-series chart (label + value)'),
        chart_type: z.enum(['line', 'area', 'bar', 'pie']).optional(),
        labels: z.array(z.string()).optional().describe('chart: x-axis labels, one per value of each series'),
        series: z
          .array(z.object({ name: z.string(), values: z.array(z.number()) }))
          .optional()
          .describe('chart: one or more series (several = comparison)'),
        unit: z.string().optional().describe('Unit of the values, e.g. "€", "%", "°C"'),
        columns: z.array(z.string()).optional().describe('table: column headers'),
        rows: z.array(z.array(z.string())).optional().describe('table: rows of cells, as text'),
        view: z.enum(['globe', 'flat']).optional().describe('map: globe (default) or flat world map'),
        map_mode: z
          .enum(['markers', 'heat'])
          .optional()
          .describe('map: "heat" colours whole countries by their value (items: label = country, value = the figure), e.g. population, GDP, results by country'),
        routes: z
          .array(z.object({ from: z.string(), to: z.string(), label: z.string().optional() }))
          .optional()
          .describe('map: arrows between places (flights, legs of a trip, flows), by place name'),
        connect: z.boolean().optional().describe('map: join the items with arrows in their order (an itinerary)'),
        focus: z.string().optional().describe('map: centre the view on this place (an item or any place name), e.g. to zoom in somewhere'),
        zoom: z.number().optional().describe('map: 1 = whole world, 2 = continent, 4 = country, 7 = region, 10 = closest'),
        tour: z
          .boolean()
          .optional()
          .describe('map: guided tour ("fais-moi visiter") — the map flies to each item in order as your spoken reply names it: describe the stops in order, one or two sentences each, naming each place'),
        source: z.string().optional().describe('Where the data comes from, shown in small print'),
        revise_previous: z.boolean().optional().describe('Add to / update the widget on screen instead of making a new one'),
        language: z.string().optional(),
      }),
      execute: async (input) => {
        const lang = resolveLang(input.language, defaultLanguage);
        let spec: WidgetSpec = {
          kind: input.widget,
          title: input.title,
          subtitle: input.subtitle,
          items: (input.items ?? []).slice(0, MAX_ITEMS).map(({ lat, lon, ...item }) => ({
            ...item,
            ...(lat !== undefined && lon !== undefined && { coords: { name: item.place ?? item.label, lat, lon } }),
          })),
          chartType: input.chart_type,
          labels: input.labels,
          series: input.series,
          unit: input.unit,
          columns: input.columns,
          rows: input.rows,
          view: input.view,
          mapMode: input.map_mode,
          routes: input.routes,
          connect: input.connect,
          focus: input.focus,
          zoom: input.zoom,
          tour: input.tour,
          ...((input.focus || input.zoom !== undefined) && { cameraAt: Date.now() }),
          source: input.source,
        };

        if (spec.kind === 'map') {
          hooks.onActivity(lang === 'fr' ? 'Je place les lieux…' : 'Placing the locations…');
          try {
            const heat = spec.mapMode === 'heat';
            const located = await Promise.all(
              spec.items.map(async (item) => {
                // Heat mode: whole countries, known offline; anything else (a microstate, a city)
                // becomes a coloured dot.
                const country = heat ? findCountry(item.place ?? item.label) : -1;
                if (country >= 0) return { ...item, country };
                // Geocoding first: model-written coordinates are only a fallback.
                const found = await geocode(item.place ?? item.label, lang);
                return { ...item, coords: found ?? item.coords };
              }),
            );
            // Route ends: a place already on the map, or geocoded.
            const known = new Map(located.filter((i) => i.coords).map((i) => [(i.place ?? i.label).toLowerCase(), i.coords!]));
            const locate = async (name: string) => known.get(name.toLowerCase()) ?? (await geocode(name, lang)) ?? undefined;
            const routes = await Promise.all(
              (spec.routes ?? []).map(async (r) => ({ ...r, fromCoords: await locate(r.from), toCoords: await locate(r.to) })),
            );
            // The camera's place: an item of the map, else geocoded.
            // A country: its geographic centre (the geocoders give its capital).
            const focusCountry = spec.focus ? findCountry(spec.focus) : -1;
            const focusCoords = !spec.focus
              ? undefined
              : (known.get(spec.focus.toLowerCase()) ??
                (focusCountry >= 0 ? { ...country(focusCountry), name: spec.focus } : (await geocode(spec.focus, lang)) ?? undefined));
            spec = {
              ...spec,
              items: located,
              focusCoords,
              routes: routes.length ? routes : undefined,
              notFound: [
                ...located.filter((i) => !i.coords && i.country === undefined).map((i) => i.place ?? i.label),
                ...routes.flatMap((r) => [!r.fromCoords && r.from, !r.toCoords && r.to].filter((n): n is string => !!n)),
              ],
            };
          } finally {
            hooks.onActivity(null);
          }
        }

        const previous = hooks.lastVisual();
        // A camera order alone ("zoome sur la France") is about the map on screen.
        const cameraOnly = spec.kind === 'map' && !spec.items.length && !spec.routes?.length && spec.cameraAt !== undefined;
        const base = (input.revise_previous || cameraOnly) && previous?.format === 'widget' && previous.widget?.kind === spec.kind ? previous : null;
        if (base?.widget) spec = merge(base.widget, spec);
        const distances = spec.kind === 'map' ? routeDistances(spec) : [];
        const visual: VisualBriefing = {
          id: base?.id ?? widgetId(),
          kind: 'visual',
          heading: spec.title,
          format: 'widget',
          widget: spec,
          content: JSON.stringify(spec, null, 2),
          status: 'done',
        };
        hooks.onBriefing(visual);
        return {
          shownOnScreen: true,
          widget: spec.kind,
          items: spec.items.length || spec.rows?.length || spec.series?.length || 0,
          ...(spec.notFound?.length && { notFound: spec.notFound, tip: 'These places could not be located: give a more precise name, or lat/lon.' }),
          // Shown on the arrows too; given here so they can be said ("9 712 km à vol d'oiseau").
          ...(distances.length && { distances, distanceNote: 'Great-circle distances (as the crow flies), computed exactly.' }),
          ...(spec.cameraAt && { view: spec.focus ? `centred on ${spec.focus}${spec.zoom ? `, zoom ${spec.zoom}` : ''}` : `zoom ${spec.zoom}` }),
          note: 'The widget is on screen: describe it in one or two sentences, do not read its content.',
        };
      },
    }),

    pin_widget: tool({
      description:
        'Pin the widget on screen to a dashboard that stays on the HUD across restarts ("garde ce tableau de bord", "épingle ça dans mon écran du matin"). Live figures keep refreshing by themselves, at no cost.',
      inputSchema: z.object({ dashboard: z.string().optional().describe('Dashboard name, e.g. "Écran du matin"; omit for the main one') }),
      execute: async ({ dashboard }) => {
        await dashboardStore.load();
        const visual = hooks.lastVisual();
        if (visual?.format !== 'widget' || !visual.widget) return { pinned: false, note: 'No widget on screen to pin: show it with show_data first.' };
        const d = dashboardStore.pin(visual.widget, dashboard);
        return { pinned: visual.widget.title, dashboard: d.name, widgets: d.widgets.length };
      },
    }),

    show_dashboard: tool({
      description: 'Show a pinned dashboard ("affiche mon écran du matin"), close it (close: true), or list the dashboards.',
      inputSchema: z.object({ name: z.string().optional(), close: z.boolean().optional() }),
      execute: async ({ name, close }) => {
        await dashboardStore.load();
        if (close) {
          dashboardStore.open(null);
          return { closed: true };
        }
        const all = dashboardStore.state().dashboards.map((d) => `${d.name} (${d.widgets.length})`);
        const d = findDashboard(name);
        if (!d) return { shown: false, dashboards: all, note: all.length ? 'No dashboard by that name.' : 'No dashboard yet: pin a widget with pin_widget.' };
        dashboardStore.open(d.id);
        return { shown: d.name, widgets: d.widgets.map((w) => w.spec.title), dashboards: all };
      },
    }),
  };
}
