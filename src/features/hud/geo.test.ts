import { beforeAll, describe, expect, it, vi } from 'vitest';
import { distanceKm, formatKm, greatCircle, heatScale, loadOutlines, rampColor } from './geo';
import { country, countryAt, findCountry, hasCells } from './countries';
import { citiesAtZoom, loadCities } from './cities';
import { setUiLanguage } from '../../i18n';

// Country names are looked up in French and English whatever the interface language; distances
// and city names follow the interface language (French here).
beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'fr-FR' });
  setUiLanguage('fr');
});

const P = (lat: number, lon: number) => ({ name: '', lat, lon });

describe('great-circle distances', () => {
  it('matches known distances (±0.5 %)', () => {
    expect(distanceKm(P(48.8566, 2.3522), P(35.6762, 139.6503))).toBeCloseTo(9712, -2); // Paris → Tokyo
    expect(Math.abs(distanceKm(P(48.8566, 2.3522), P(40.7128, -74.006)) - 5837)).toBeLessThan(30); // Paris → New York
    expect(distanceKm(P(10, 10), P(10, 10))).toBeLessThan(0.01);
  });

  it('draws the path between the two ends', () => {
    const path = greatCircle(P(48.85, 2.35), P(35.68, 139.65), 10);
    expect(path).toHaveLength(11);
    expect(path[0][0]).toBeCloseTo(48.85, 5);
    expect(path[10][1]).toBeCloseTo(139.65, 5);
    // It goes north of both ends (the polar route), as planes do.
    expect(Math.max(...path.map((p) => p[0]))).toBeGreaterThan(60);
  });

  it('formats distances', () => {
    expect(formatKm(9712.4).replace(/\s/g, ' ')).toBe('9 712 km');
  });
});

describe('heat scale', () => {
  it('uses a log scale for very skewed values', () => {
    const s = heatScale([95, 3200, 30300]);
    expect(s.log).toBe(true);
    expect(s.t(95)).toBe(0);
    expect(s.t(30300)).toBeCloseTo(1);
    expect(s.t(3200)).toBeGreaterThan(0.5); // log: the middle value is not squashed near 0
  });

  it('is linear otherwise', () => {
    const s = heatScale([10, 20, 30]);
    expect(s.log).toBe(false);
    expect(s.t(20)).toBeCloseTo(0.5);
  });

  it('goes from dark to light', () => {
    const lum = (c: string) => c.match(/\d+/g)!.map(Number).reduce((a, b) => a + b, 0);
    expect(lum(rampColor(1))).toBeGreaterThan(lum(rampColor(0)));
  });
});

describe('countries (heat maps, offline)', () => {
  it.each([
    ['États-Unis', 'US'],
    ['USA', 'US'],
    ['Angleterre', 'GB'],
    ['la France', 'FR'],
    ['Allemagne', 'DE'],
    ['Côte d’Ivoire', 'CI'],
    ['Corée du Sud', 'KR'],
    ['DE', 'DE'],
  ])('%s → %s', (name, code) => {
    const i = findCountry(name);
    expect(i).toBeGreaterThanOrEqual(0);
    expect(country(i).code).toBe(code);
  });

  it('finds the country of a point, and nothing at sea', () => {
    expect(country(countryAt(48.8, 2.3)).code).toBe('FR');
    expect(country(countryAt(35.7, 139.7)).code).toBe('JP');
    expect(countryAt(0, -30)).toBe(-1);
  });

  it('knows which countries are too small for the grid', () => {
    expect(hasCells(findCountry('France'))).toBe(true);
    expect(hasCells(findCountry('Luxembourg'))).toBe(false);
  });
});

describe('built-in map data', () => {
  it('decodes coastlines and borders', async () => {
    const lines = await loadOutlines();
    expect(lines.length).toBeGreaterThan(500);
    expect(lines.some((l) => l.border)).toBe(true);
    for (const l of lines.slice(0, 50)) for (const v of l.points) expect(Math.abs(v)).toBeLessThanOrEqual(180);
  });

  it('decodes the cities, with French names, more of them as the zoom grows', async () => {
    const cities = await loadCities();
    expect(cities.find((c) => c.name === 'Londres')?.capital).toBe(true);
    expect(citiesAtZoom(1, cities)).toHaveLength(0);
    expect(citiesAtZoom(3, cities).length).toBeLessThan(citiesAtZoom(6, cities).length);
  });
});
