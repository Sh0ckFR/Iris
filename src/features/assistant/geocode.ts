import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import type { GeoPoint } from './tools';

/**
 * Free geocoding for the map widget: place names → coordinates, so the model only writes names
 * (a few tokens) instead of coordinates or map code.
 *  1. world regions ("Moyen-Orient", "Europe"…), built in: no geocoder knows them as one point;
 *  2. Open-Meteo (GeoNames): countries and cities, in the user's language;
 *  3. OpenStreetMap Nominatim: everything else (straits, landmarks, islands…), one request per
 *     second as its usage policy asks.
 * Results are remembered on this computer (a place doesn't move).
 */

const CACHE_KEY = 'iris.geocode.v1';
const MAX_CACHED = 2000;

const normalize = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’'-]/g, ' ').replace(/\s+/g, ' ').trim();

const REGIONS: [names: string[], lat: number, lon: number][] = [
  [['moyen orient', 'proche orient', 'middle east', 'near east'], 29, 45],
  [['europe'], 50, 12],
  [['europe de l est', 'eastern europe'], 50, 28],
  [['asie', 'asia'], 35, 95],
  [['asie du sud est', 'southeast asia', 'south east asia'], 8, 110],
  [['asie centrale', 'central asia'], 43, 65],
  [['afrique', 'africa'], 3, 20],
  [['afrique de l ouest', 'west africa'], 12, -3],
  [['afrique de l est', 'east africa'], 0, 37],
  [['maghreb', 'afrique du nord', 'north africa'], 30, 5],
  [['sahel'], 15, 5],
  [['amerique du nord', 'north america'], 45, -100],
  [['amerique du sud', 'south america'], -15, -60],
  [['amerique latine', 'latin america'], -5, -65],
  [['amerique centrale', 'central america'], 14, -87],
  [['caraibes', 'caribbean'], 17, -72],
  [['oceanie', 'oceania'], -22, 140],
  [['balkans'], 43, 20],
  [['scandinavie', 'scandinavia'], 63, 15],
  [['arctique', 'arctic', 'pole nord', 'north pole'], 82, 0],
  [['antarctique', 'antarctica', 'pole sud', 'south pole'], -82, 0],
  [['mediterranee', 'mer mediterranee', 'mediterranean', 'mediterranean sea'], 36, 15],
  [['golfe persique', 'persian gulf', 'golfe arabo persique'], 27, 51],
  [['mer de chine meridionale', 'south china sea'], 12, 114],
  [['mer rouge', 'red sea'], 20, 38],
  [['mer noire', 'black sea'], 43, 35],
  [['ocean atlantique', 'atlantique', 'atlantic', 'atlantic ocean'], 20, -40],
  [['ocean pacifique', 'pacifique', 'pacific', 'pacific ocean'], 0, -160],
  [['ocean indien', 'indian ocean'], -20, 80],
  [['sibérie', 'siberie', 'siberia'], 62, 100],
];

let cache: Record<string, GeoPoint | null> | null = null;

function store(): Record<string, GeoPoint | null> {
  if (!cache) {
    try {
      cache = JSON.parse(localStorage.getItem(CACHE_KEY) ?? '{}') as Record<string, GeoPoint | null>;
    } catch {
      cache = {};
    }
  }
  return cache;
}

function remember(key: string, value: GeoPoint | null) {
  const c = store();
  c[key] = value;
  const keys = Object.keys(c);
  if (keys.length > MAX_CACHED) keys.slice(0, keys.length - MAX_CACHED).forEach((k) => delete c[k]);
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(c));
  } catch {
    // storage full: the in-memory cache still works this session
  }
}

async function getJson<T>(url: string, headers?: Record<string, string>): Promise<T> {
  const response = await tauriFetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`${new URL(url).host} answered HTTP ${response.status}`);
  return (await response.json()) as T;
}

async function openMeteo(name: string, lang: string): Promise<GeoPoint | null> {
  const data = await getJson<{
    results?: { name: string; latitude: number; longitude: number; population?: number; feature_code?: string }[];
  }>(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=5&language=${lang}&format=json`);
  const results = data.results ?? [];
  const wanted = normalize(name);
  // Same name first (countries before towns of the same name), then the most populated.
  const rank = (r: (typeof results)[number]) =>
    (normalize(r.name) === wanted ? 2e10 : 0) + (/^PCL/.test(r.feature_code ?? '') ? 1e10 : 0) + (r.population ?? 0);
  const best = [...results].sort((a, b) => rank(b) - rank(a))[0];
  // A different name with no population is a guess (a hamlet for "SpaceX"): leave it to Nominatim.
  if (!best || (normalize(best.name) !== wanted && !best.population)) return null;
  return { name: best.name, lat: best.latitude, lon: best.longitude };
}

/** Nominatim allows one request per second: calls wait for each other. */
let nominatimQueue: Promise<unknown> = Promise.resolve();
/** Results that are businesses or services, not places. */
const NOT_A_PLACE = new Set(['shop', 'amenity', 'craft', 'healthcare', 'club', 'emergency']);

function nominatim(name: string, lang: string): Promise<GeoPoint | null> {
  const run = async () => {
    const results = await getJson<{ name?: string; display_name: string; lat: string; lon: string; category?: string; importance?: number }[]>(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(name)}&format=jsonv2&limit=3&accept-language=${lang}`,
      { 'User-Agent': 'Iris-Assistant/0.1 (desktop assistant; map widget)' },
    );
    const best = results.filter((r) => !NOT_A_PLACE.has(r.category ?? '')).sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0))[0];
    return best ? { name: best.name || best.display_name.split(',')[0], lat: Number(best.lat), lon: Number(best.lon) } : null;
  };
  const next = nominatimQueue.then(run, run);
  nominatimQueue = next.then(
    () => new Promise((r) => setTimeout(r, 1100)),
    () => new Promise((r) => setTimeout(r, 1100)),
  );
  return next;
}

/** Coordinates of a place name, or null when no geocoder knows it. */
export async function geocode(name: string, lang: string): Promise<GeoPoint | null> {
  const clean = name.trim();
  if (!clean) return null;
  const key = `${lang}:${normalize(clean)}`;
  const known = store();
  if (key in known) return known[key];

  const region = REGIONS.find(([names]) => names.includes(normalize(clean)));
  if (region) return { name: clean, lat: region[1], lon: region[2] };

  let found: GeoPoint | null = null;
  let failed = false;
  for (const lookup of [openMeteo, nominatim]) {
    try {
      found = await lookup(clean, lang);
      if (found) break;
    } catch (error) {
      failed = true;
      console.warn(`[iris:geo] ${lookup.name} failed for "${clean}"`, error);
    }
  }
  // Network failures are not remembered (it may work next time); unknown places are.
  if (found || !failed) remember(key, found && { ...found, name: clean });
  return found && { ...found, name: clean };
}
