import { beforeAll, describe, expect, it, vi } from 'vitest';

// Places are located without the network: a small gazetteer.
const PLACES: Record<string, [number, number]> = { paris: [48.8566, 2.3522], tokyo: [35.6762, 139.6503], sydney: [-33.8688, 151.2093], 'new york': [40.7128, -74.006] };
vi.mock('./geocode', () => ({
  geocode: vi.fn(async (name: string) => {
    const p = PLACES[name.toLowerCase()];
    return p ? { name, lat: p[0], lon: p[1] } : null;
  }),
}));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }));

const { createWidgetTools, merge } = await import('./widgetTools');
import type { VisualBriefing } from './tools';

beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'fr-FR' });
});

function setup() {
  let shown: VisualBriefing | null = null;
  const tools = createWidgetTools({ onActivity: () => {}, onBriefing: (b) => (shown = b as VisualBriefing), lastVisual: () => shown }, 'fr');
  const run = (input: Record<string, unknown>) => tools.show_data.execute!(input as never, { toolCallId: 't', messages: [] } as never) as Promise<Record<string, unknown>>;
  return { run, shown: () => shown! };
}

describe('show_data: maps', () => {
  it('locates the places, gives the distances of an itinerary and its total', async () => {
    const { run, shown } = setup();
    const r = await run({ widget: 'map', title: 'Voyage', connect: true, items: [{ label: 'Paris' }, { label: 'Tokyo' }, { label: 'Sydney' }] });
    expect(shown().widget!.items.every((i) => i.coords)).toBe(true);
    expect(r.distances).toEqual(['Paris → Tokyo: 9712 km', 'Tokyo → Sydney: 7826 km', 'Itinerary total: 17538 km']);
  });

  it('a separate route is not part of the itinerary total', async () => {
    const { run } = setup();
    const r = await run({ widget: 'map', title: 'V', connect: true, items: [{ label: 'Paris' }, { label: 'Tokyo' }, { label: 'Sydney' }], routes: [{ from: 'Paris', to: 'New York' }] });
    expect(r.distances).toContain('Paris → New York: 5837 km');
    expect(r.distances).toContain('Itinerary total: 17538 km');
  });

  it('a camera order alone moves the map on screen (same widget, same places)', async () => {
    const { run, shown } = setup();
    await run({ widget: 'map', title: 'Voyage', items: [{ label: 'Paris' }, { label: 'Tokyo' }] });
    const id = shown().id;
    const r = await run({ widget: 'map', title: 'Voyage', focus: 'Tokyo', zoom: 4 });
    expect(shown().id).toBe(id);
    expect(shown().widget!.items).toHaveLength(2);
    expect(shown().widget!.focusCoords).toMatchObject({ lat: 35.6762 });
    expect(r.view).toBe('centred on Tokyo, zoom 4');
  });

  it('heat maps know countries offline, and report the unknown places', async () => {
    const { run, shown } = setup();
    const r = await run({ widget: 'map', title: 'PIB', map_mode: 'heat', items: [{ label: 'France', value: 3 }, { label: 'Atlantide', value: 1 }] });
    expect(shown().widget!.items[0].country).toBeGreaterThanOrEqual(0);
    expect(r.notFound).toEqual(['Atlantide']);
  });
});

describe('revise_previous', () => {
  it('adds items, replacing those with the same label', () => {
    const base = { kind: 'map' as const, title: 'A', items: [{ label: 'Paris', value: 1 }, { label: 'Tokyo' }] };
    const merged = merge(base, { kind: 'map', title: 'A', items: [{ label: 'paris', value: 2 }, { label: 'Berlin' }] });
    expect(merged.items.map((i) => [i.label, i.value])).toEqual([
      ['paris', 2],
      ['Tokyo', undefined],
      ['Berlin', undefined],
    ]);
  });
});
