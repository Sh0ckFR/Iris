/**
 * Major cities as landmarks when a map is zoomed in: the bigger the zoom, the smaller the cities
 * shown (capitals and megacities first). Labels never overlap each other nor the map's own places.
 * French names for the cities whose name differs (the data is in English).
 */
import { uiLanguage } from '../../i18n';

export interface City {
  name: string;
  lat: number;
  lon: number;
  /** Thousands of inhabitants. */
  pop: number;
  capital: boolean;
}

const FRENCH: Record<string, string> = {
  London: 'Londres', Moscow: 'Moscou', Beijing: 'Pékin', Vienna: 'Vienne', Brussels: 'Bruxelles', Lisbon: 'Lisbonne',
  Warsaw: 'Varsovie', Athens: 'Athènes', Copenhagen: 'Copenhague', Geneva: 'Genève', Venice: 'Venise', Seville: 'Séville',
  Cairo: 'Le Caire', Algiers: 'Alger', 'Mexico City': 'Mexico', Seoul: 'Séoul', Singapore: 'Singapour', Tehran: 'Téhéran',
  Baghdad: 'Bagdad', Jerusalem: 'Jérusalem', 'Cape Town': 'Le Cap', 'New Delhi': 'New Delhi', Riyadh: 'Riyad', Kiev: 'Kiev',
  Kyiv: 'Kiev', Bucharest: 'Bucarest', Edinburgh: 'Édimbourg', Havana: 'La Havane', Antwerp: 'Anvers', Barcelona: 'Barcelone',
  Montreal: 'Montréal', Quebec: 'Québec', 'New Orleans': 'La Nouvelle-Orléans', Philadelphia: 'Philadelphie', Kabul: 'Kaboul',
  Damascus: 'Damas', Beirut: 'Beyrouth', 'Addis Ababa': 'Addis-Abeba', Marrakesh: 'Marrakech', Nicosia: 'Nicosie',
  Valletta: 'La Valette', Munich: 'Munich', Cologne: 'Cologne', Hamburg: 'Hambourg', Milan: 'Milan', Turin: 'Turin',
  Naples: 'Naples', Florence: 'Florence', Rome: 'Rome', Prague: 'Prague', Budapest: 'Budapest', Belgrade: 'Belgrade',
  Sofia: 'Sofia', Istanbul: 'Istanbul', Ankara: 'Ankara', 'Tel Aviv-Yafo': 'Tel Aviv', Mecca: 'La Mecque', Karachi: 'Karachi',
  Bombay: 'Bombay', Mumbai: 'Bombay', Calcutta: 'Calcutta', Kolkata: 'Calcutta', Rangoon: 'Rangoun', Yangon: 'Rangoun',
  'Ho Chi Minh City': 'Hô Chi Minh-Ville', Hanoi: 'Hanoï', 'Kuala Lumpur': 'Kuala Lumpur', Manila: 'Manille', Taipei: 'Taipei',
  'Hong Kong': 'Hong Kong', Canton: 'Canton', Guangzhou: 'Canton', Nanjing: 'Nankin', Tianjin: 'Tianjin', Chongqing: 'Chongqing',
  'Rio de Janeiro': 'Rio de Janeiro', 'Sao Paulo': 'São Paulo', 'São Paulo': 'São Paulo', 'Buenos Aires': 'Buenos Aires',
  Bogota: 'Bogota', Lima: 'Lima', Santiago: 'Santiago', Caracas: 'Caracas', Johannesburg: 'Johannesbourg', Lagos: 'Lagos',
  Kinshasa: 'Kinshasa', Nairobi: 'Nairobi', Khartoum: 'Khartoum', 'Dar es Salaam': 'Dar es Salam', Tunis: 'Tunis',
  Tripoli: 'Tripoli', Rabat: 'Rabat', Casablanca: 'Casablanca', Dakar: 'Dakar', Abidjan: 'Abidjan', Accra: 'Accra',
  'The Hague': 'La Haye', Amsterdam: 'Amsterdam', Stockholm: 'Stockholm', Oslo: 'Oslo', Helsinki: 'Helsinki', Dublin: 'Dublin',
  Reykjavik: 'Reykjavik', Minsk: 'Minsk', Vilnius: 'Vilnius', Riga: 'Riga', Tallinn: 'Tallinn', Zagreb: 'Zagreb',
  Ljubljana: 'Ljubljana', Bratislava: 'Bratislava', Tbilisi: 'Tbilissi', Yerevan: 'Erevan', Baku: 'Bakou', Tashkent: 'Tachkent',
  Pyongyang: 'Pyongyang', Ulaanbaatar: 'Oulan-Bator', Kathmandu: 'Katmandou', Dhaka: 'Dacca', Colombo: 'Colombo',
};

let cities: City[] | null = null;

/** Decoded the first time a map is zoomed in. */
export async function loadCities(): Promise<City[]> {
  if (cities) return cities;
  const { CITIES_DATA } = await import('./citiesData');
  const fr = uiLanguage() === 'fr';
  cities = CITIES_DATA.split(';').map((row) => {
    const [name, lat, lon, pop, capital] = row.split('|');
    return { name: (fr && FRENCH[name]) || name, lat: Number(lat), lon: Number(lon), pop: Number(pop), capital: capital === '1' };
  });
  return cities;
}

/** Which cities a zoom level shows (none when the whole world is in view). */
export function citiesAtZoom(zoom: number, list: City[]): City[] {
  if (zoom < 2.2) return [];
  const minPop = zoom < 3.5 ? 5000 : zoom < 5.5 ? 1000 : 0;
  return list.filter((c) => c.pop >= minPop || (c.capital && zoom >= 2.8));
}

type Box = { x: number; y: number; w: number; h: number };
const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Draws the cities (already filtered and in priority order) at their projected positions:
 * a small dot, a ring for capitals, a dim label. `avoid`: the map's own places, never covered.
 */
export function drawCities(
  ctx: CanvasRenderingContext2D,
  list: City[],
  project: (lat: number, lon: number) => { x: number; y: number; visible: boolean },
  width: number,
  height: number,
  avoid: { x: number; y: number }[],
  fontSize = 10,
  max = 60,
) {
  const taken: Box[] = avoid.map((p) => ({ x: p.x - 40, y: p.y - 22, w: 150, h: 28 }));
  ctx.font = `500 ${fontSize}px system-ui, "Segoe UI", sans-serif`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  let drawn = 0;
  for (const c of list) {
    if (drawn >= max) break;
    const p = project(c.lat, c.lon);
    if (!p.visible || p.x < 0 || p.y < 0 || p.x > width || p.y > height) continue;
    const w = ctx.measureText(c.name).width;
    const box = { x: p.x - 3, y: p.y - fontSize / 2 - 2, w: w + 12, h: fontSize + 4 };
    if (taken.some((t) => overlaps(t, box))) continue;
    taken.push(box);
    drawn++;
    ctx.globalAlpha = c.capital ? 0.95 : 0.75;
    ctx.fillStyle = '#e6f5d6';
    ctx.beginPath();
    ctx.arc(p.x, p.y, c.capital ? 2.2 : 1.6, 0, Math.PI * 2);
    ctx.fill();
    if (c.capital) {
      ctx.strokeStyle = '#e6f5d6';
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = c.capital ? '#e6f5d6' : 'rgba(230, 245, 214, 0.75)';
    ctx.fillText(c.name, p.x + 6, p.y);
  }
  ctx.textBaseline = 'alphabetic';
  ctx.globalAlpha = 1;
}
