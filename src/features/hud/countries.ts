import { COUNTRIES, COUNTRY_GRID_HEIGHT, COUNTRY_GRID_RLE_BASE64, COUNTRY_GRID_WIDTH } from './countryGrid';
import { uiLocale } from '../../i18n';

/**
 * Countries for the heat mode of the map widget, offline: which country a point is in (1° grid),
 * and which country a name means ("États-Unis", "USA", "United States", "US" → the same one).
 */

export interface Country {
  index: number;
  code: string;
  name: string;
  lat: number;
  lon: number;
}

const GRID: Uint8Array = (() => {
  const rle = Uint8Array.from(atob(COUNTRY_GRID_RLE_BASE64), (c) => c.charCodeAt(0));
  const grid = new Uint8Array(COUNTRY_GRID_WIDTH * COUNTRY_GRID_HEIGHT);
  let n = 0;
  for (let i = 0; i < rle.length; i += 2) {
    grid.fill(rle[i], n, n + rle[i + 1]);
    n += rle[i + 1];
  }
  return grid;
})();

/** Countries big enough to own grid cells (the others, like Luxembourg, are drawn as a dot). */
const WITH_CELLS = new Set(GRID);
export const hasCells = (index: number) => WITH_CELLS.has(index + 1);

/** Index in COUNTRIES of the country at a point, or -1 at sea. */
export function countryAt(lat: number, lon: number): number {
  const i = Math.min(COUNTRY_GRID_WIDTH - 1, Math.max(0, Math.floor(lon + 180)));
  const j = Math.min(COUNTRY_GRID_HEIGHT - 1, Math.max(0, Math.floor(90 - lat)));
  return GRID[j * COUNTRY_GRID_WIDTH + i] - 1;
}

export function country(index: number): Country {
  const [code, name, lat, lon] = COUNTRIES[index];
  return { index, code, name: displayName(code) ?? name, lat, lon };
}

const normalize = (s: string) =>
  s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’'.-]/g, ' ').replace(/\s+/g, ' ').trim();

function displayName(code: string, lang = uiLocale()): string | undefined {
  if (!code) return undefined;
  try {
    return new Intl.DisplayNames([lang], { type: 'region' }).of(code);
  } catch {
    return undefined;
  }
}

/** Other names people use (the official names come from Intl and Natural Earth). */
const ALIASES: Record<string, string> = {
  usa: 'US', 'etats unis d amerique': 'US', amerique: 'US', america: 'US', 'united states': 'US',
  uk: 'GB', angleterre: 'GB', england: 'GB', 'grande bretagne': 'GB', 'great britain': 'GB', ecosse: 'GB', scotland: 'GB',
  hollande: 'NL', holland: 'NL', russia: 'RU', 'coree': 'KR', korea: 'KR', 'coree du sud': 'KR', 'south korea': 'KR',
  'coree du nord': 'KP', 'north korea': 'KP', 'republique tcheque': 'CZ', 'czech republic': 'CZ', birmanie: 'MM', burma: 'MM',
  'cote d ivoire': 'CI', 'ivory coast': 'CI', 'rdc': 'CD', 'congo kinshasa': 'CD', 'congo brazzaville': 'CG', 'emirats': 'AE', uae: 'AE',
  'emirats arabes unis': 'AE', turquie: 'TR', turkiye: 'TR', swaziland: 'SZ', 'macedoine': 'MK', 'macedonia': 'MK', vatican: 'IT',
  gaza: 'PS', cisjordanie: 'PS', 'west bank': 'PS', taiwan: 'TW', 'chine taiwan': 'TW', iran: 'IR', syrie: 'SY', syria: 'SY',
};

let index: Map<string, number> | null = null;

function nameIndex(): Map<string, number> {
  if (index) return index;
  index = new Map();
  const byCode = new Map<string, number>();
  COUNTRIES.forEach(([code, name], i) => {
    const add = (n: string | undefined) => n && !index!.has(normalize(n)) && index!.set(normalize(n), i);
    add(name);
    if (!code) return;
    byCode.set(code, i);
    add(code);
    add(displayName(code, 'fr'));
    add(displayName(code, 'en'));
  });
  for (const [alias, code] of Object.entries(ALIASES)) {
    const i = byCode.get(code);
    if (i !== undefined && !index.has(alias)) index.set(alias, i);
  }
  return index;
}

/** The country a name or ISO code means, or -1. */
export function findCountry(name: string): number {
  const n = normalize(name);
  const names = nameIndex();
  return names.get(n) ?? names.get(n.replace(/^(la|le|les|l|the) /, '')) ?? -1;
}
