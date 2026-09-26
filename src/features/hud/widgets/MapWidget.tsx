import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GeoPoint } from '../../assistant/tools';
import type { WidgetItem, WidgetSpec } from '../../assistant/widgetTools';
import { HoloGlobe } from '../HoloGlobe';
import { FlatMap } from '../FlatMap';
import { country, countryAt, hasCells } from '../countries';
import { distanceKm, formatKm, heatScale, NO_DATA, RAMP_CSS, rampColor, type Route } from '../geo';
import { categoryColors, withUnit } from './palette';
import { ItemLink } from './common';
import { onSentence } from '../../../lib/narration';
import { useT } from '../../../i18n';



type Hit = { lat: number; lon: number; x: number; y: number } | null;

/**
 * Places on the holographic globe or a flat map, with the list of items beside it: click an item
 * or a beacon to turn the globe to it and read its details. Routes draw animated arrows between
 * places; the heat mode colours whole countries by their value.
 */
export function MapWidget({ spec }: { spec: WidgetSpec }) {
  const heat = spec.mapMode === 'heat';
  const m = useT();
  const t = m.map;

  // ---- the places, in list order (heat mode: highest value first)
  const entries = useMemo(() => {
    const withPlace = spec.items
      .map((item) => {
        const c = item.country !== undefined ? country(item.country) : null;
        const coords: GeoPoint | undefined = c ? { name: c.name, lat: c.lat, lon: c.lon } : item.coords;
        return coords ? { item, coords, countryName: c?.name } : null;
      })
      .filter((e): e is { item: WidgetItem; coords: GeoPoint; countryName: string | undefined } => e !== null);
    return heat ? withPlace.sort((a, b) => (b.item.value ?? -Infinity) - (a.item.value ?? -Infinity)) : withPlace;
  }, [spec.items, heat]);

  const scale = useMemo(() => (heat ? heatScale(entries.map((e) => e.item.value ?? NaN)) : null), [heat, entries]);
  const { colorOf, groups } = useMemo(() => categoryColors(entries.map((e) => e.item.category)), [entries]);
  const colorFor = useCallback(
    (item: WidgetItem) => (scale && item.value !== undefined ? rampColor(scale.t(item.value)) : colorOf(item.category)),
    [scale, colorOf],
  );
  // Beacon labels carry the value when there is one ("TOKYO · 37,4 M").
  const points = useMemo(
    () =>
      entries.map((e) => {
        const name = e.item.place ?? e.countryName ?? e.item.label;
        const value = !heat && e.item.value !== undefined ? ` · ${withUnit(e.item.value, e.item.unit ?? spec.unit, true)}` : '';
        return { ...e.coords, name: name + value };
      }),
    [entries, heat, spec.unit],
  );
  const colors = useMemo(() => entries.map((e) => colorFor(e.item)), [entries, colorFor]);

  // Heat: colour of each country's land.
  const byCountry = useMemo(() => new Map(entries.filter((e) => e.item.country !== undefined).map((e) => [e.item.country!, e.item])), [entries]);
  const dotColor = useMemo(
    () => (heat ? (c: number) => { const item = byCountry.get(c); return item?.value !== undefined && scale ? rampColor(scale.t(item.value)) : null; } : undefined),
    [heat, byCountry, scale],
  );

  // Routes: the given ones, plus the items joined in order for an itinerary; each labelled with its
  // great-circle distance (and its own label when it has one).
  const legs = useMemo(() => {
    const given = (spec.routes ?? [])
      .filter((r) => r.fromCoords && r.toCoords)
      .map((r) => ({ from: r.fromCoords!, to: r.toCoords!, fromName: r.from, toName: r.to, label: r.label }));
    const nameOf = (e: (typeof entries)[number]) => e.item.place ?? e.countryName ?? e.item.label;
    const chain = spec.connect
      ? entries.slice(1).map((e, i) => ({ from: entries[i].coords, to: e.coords, fromName: nameOf(entries[i]), toName: nameOf(e), label: undefined as string | undefined, leg: true }))
      : [];
    return [...given.map((g) => ({ ...g, leg: false })), ...chain].map((l) => ({ ...l, km: distanceKm(l.from, l.to) }));
  }, [spec.routes, spec.connect, entries]);
  const routes = useMemo<Route[]>(
    () => legs.map((l) => ({ from: l.from, to: l.to, label: [l.label, formatKm(l.km)].filter(Boolean).join(' · ') })),
    [legs],
  );
  // The itinerary's total (separate routes are not part of it).
  const itinerary = legs.filter((l) => l.leg);
  const totalKm = itinerary.reduce((n, l) => n + l.km, 0);

  const [selected, setSelected] = useState<number | null>(entries.length ? 0 : null);
  const [view, setView] = useState<'globe' | 'flat'>(spec.view ?? 'globe');
  const [spin, setSpin] = useState(false);
  const [hit, setHit] = useState<Hit>(null);
  const entry = selected !== null ? entries[selected] : null;

  // Camera orders from Iris ("zoome sur la France"): an item of the map is selected, any other
  // place is just looked at.
  const normalize = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
  const focusIndex = spec.focus
    ? entries.findIndex((e) => [e.item.label, e.item.place, e.countryName].some((n) => n && normalize(n) === normalize(spec.focus!)))
    : -1;
  // The camera: Iris's orders, the guided tour and the narration all move it.
  const [cam, setCam] = useState<{ focus: GeoPoint | null; zoom?: number; key?: number }>(() => ({
    focus: spec.cameraAt ? (spec.focusCoords ?? (focusIndex >= 0 ? entries[focusIndex].coords : null)) : null,
    zoom: spec.cameraAt ? spec.zoom : undefined,
    key: spec.cameraAt,
  }));
  useEffect(() => {
    if (!spec.cameraAt) return;
    if (focusIndex >= 0) setSelected(focusIndex);
    setCam({ focus: spec.focusCoords ?? (focusIndex >= 0 ? entries[focusIndex].coords : null), zoom: spec.zoom, key: spec.cameraAt });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec.cameraAt]);

  // ---- guided tour: from stop to stop, following what Iris says (or by itself when she is silent)
  const [touring, setTouring] = useState(!!spec.tour);
  const tourZoom = spec.zoom && spec.zoom > 1.5 ? spec.zoom : 3.5;
  const lastNarration = useRef(0);
  const goTo = useCallback(
    (index: number, zoomIn: boolean) => {
      const e = entries[index];
      if (!e) return;
      setSelected(index);
      setCam({ focus: e.coords, zoom: zoomIn ? tourZoom : undefined, key: Date.now() });
    },
    [entries, tourZoom],
  );
  // The place Iris names in the sentence she starts saying (the first one named).
  useEffect(
    () =>
      onSentence((text) => {
        const said = ` ${normalize(text).replace(/[^a-z0-9]+/g, ' ')} `;
        let best = -1;
        let at = Infinity;
        entries.forEach((e, i) => {
          for (const n of [e.item.label, e.item.place, e.countryName]) {
            if (!n) continue;
            const pos = said.indexOf(` ${normalize(n).replace(/[^a-z0-9]+/g, ' ')} `);
            if (pos >= 0 && pos < at) {
              best = i;
              at = pos;
            }
          }
        });
        if (best < 0) return;
        lastNarration.current = Date.now();
        goTo(best, touring);
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [entries, touring, goTo],
  );
  // Without narration (typed request, voice off), the tour moves on by itself every few seconds.
  useEffect(() => {
    if (!touring) return;
    goTo(0, true);
    let index = 0;
    const timer = window.setInterval(() => {
      if (Date.now() - lastNarration.current < 7000) return; // Iris is narrating
      index += 1;
      if (index >= entries.length) {
        setTouring(false);
        setCam({ focus: null, zoom: 1, key: Date.now() }); // back to the whole picture
        return;
      }
      goTo(index, true);
    }, 6500);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [touring]);

  // Heat tooltip: the country under the mouse and its value.
  const tip = useMemo(() => {
    if (!heat || !hit) return null;
    const c = countryAt(hit.lat, hit.lon);
    if (c < 0) return null;
    const item = byCountry.get(c);
    return { x: hit.x, y: hit.y, name: country(c).name, value: item?.value !== undefined ? withUnit(item.value, item.unit ?? spec.unit) : m.common.noData };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heat, hit, byCountry, spec.unit]);

  // Heat: countries are shown by their colour; only places outside the grid (microstates, cities) keep a beacon.
  const quiet = useMemo(() => entries.map((e) => heat && e.item.country !== undefined && hasCells(e.item.country)), [entries, heat]);
  const mapProps = {
    points,
    selected,
    onSelect: setSelected,
    colors,
    routes,
    dotColor,
    onHover: heat ? setHit : undefined,
    quiet,
    focus: cam.focus,
    zoom: cam.zoom,
    cameraKey: cam.key,
  };

  return (
    <div className="wg-map">
      <aside className="wg-map-list">
        <p className="wg-kicker">
          {heat ? t.countries(entries.length) : t.places(entries.length)}
          {routes.length > 0 && ` · ${t.routes(routes.length)}`}
        </p>
        {entries.map((e, index) => (
          <button
            key={`${e.item.label}-${index}`}
            type="button"
            className={`wg-map-item${index === selected ? ' is-selected' : ''}`}
            onClick={() => setSelected(index)}
            style={{ ['--wg-color' as string]: colors[index] }}
          >
            {heat ? (
              <span className="wg-map-rank">
                <span className="wg-coords">{String(index + 1).padStart(2, '0')}</span>
                <b>{e.countryName ?? e.item.label}</b>
                <span className="wg-map-value">{e.item.value !== undefined ? withUnit(e.item.value, e.item.unit ?? spec.unit, true) : '—'}</span>
                {scale && e.item.value !== undefined && <span className="wg-map-bar" style={{ width: `${Math.max(3, scale.t(e.item.value) * 100)}%` }} />}
              </span>
            ) : (
              <>
                <span className="wg-map-item-head">
                  {e.item.category && <span className="wg-tag">{e.item.category}</span>}
                  <span className="wg-coords">
                    {e.coords.lat.toFixed(1)}°, {e.coords.lon.toFixed(1)}°
                  </span>
                </span>
                <b>{e.item.label}</b>
                {e.item.place && e.item.place !== e.item.label && <span className="brief-meta">{e.item.place}</span>}
              </>
            )}
          </button>
        ))}
        {legs.length > 0 && (
          <div className="wg-map-legs">
            <p className="wg-kicker">{t.distances}</p>
            {legs.map((l, i) => (
              <span key={i} className="wg-map-leg">
                <span>
                  {l.fromName} → {l.toName}
                  {l.label ? ` · ${l.label}` : ''}
                </span>
                <b>{formatKm(l.km)}</b>
              </span>
            ))}
            {itinerary.length > 1 && (
              <span className="wg-map-leg wg-map-leg--total">
                <span>{m.common.total}</span>
                <b>{formatKm(totalKm)}</b>
              </span>
            )}
          </div>
        )}
        {spec.notFound && spec.notFound.length > 0 && (
          <p className="brief-meta">
            {t.notLocated}
            {spec.notFound.join(', ')}
          </p>
        )}
      </aside>

      <div className="wg-map-stage">
        <div className="wg-map-tools">
          <div className="vis-tabs" role="tablist">
            <button type="button" className={view === 'globe' ? 'on' : ''} onClick={() => setView('globe')}>
              {t.globe}
            </button>
            <button type="button" className={view === 'flat' ? 'on' : ''} onClick={() => setView('flat')}>
              {t.flat}
            </button>
          </div>
          {view === 'globe' && (
            <button type="button" className={`set-btn set-btn--ghost${spin ? ' is-on' : ''}`} onClick={() => setSpin((s) => !s)}>
              {t.autoRotate}
            </button>
          )}
          {entries.length > 1 && (
            <button type="button" className={`set-btn set-btn--ghost${touring ? ' is-on' : ''}`} onClick={() => setTouring((v) => !v)}>
              {touring ? t.stopTour : t.tour}
            </button>
          )}
          {scale ? (
            <div className="wg-heat-legend">
              <span>{withUnit(scale.min, spec.unit, true)}</span>
              <i style={{ background: RAMP_CSS }} />
              <span>{withUnit(scale.max, spec.unit, true)}</span>
              {scale.log && <small>{t.logScale}</small>}
              <span className="wg-heat-none">
                <i style={{ background: NO_DATA }} />
                {m.common.noData}
              </span>
            </div>
          ) : (
            groups.length > 1 && (
              <div className="wg-legend">
                {groups.slice(0, 8).map((g) => (
                  <span key={g}>
                    <i style={{ background: colorOf(g) }} />
                    {g}
                  </span>
                ))}
              </div>
            )
          )}
        </div>
        <div className="wg-map-canvas">
          {view === 'globe' ? (
            <HoloGlobe {...mapProps} size="fill" interactive labelAll={!heat && points.length <= 8} autoRotate={spin} />
          ) : (
            <FlatMap {...mapProps} />
          )}
          {tip && (
            <div className="wg-tip wg-map-tip" style={{ left: tip.x, top: tip.y }}>
              <b>{tip.name}</b>
              <span>{tip.value}</span>
            </div>
          )}
          {view === 'globe' && <span className="wg-hint">{t.globeHint}</span>}
        </div>
        {entry && (
          <div className="wg-map-detail" style={{ ['--wg-color' as string]: colors[selected!] }}>
            <p className="wg-kicker">
              {entry.item.category ? `${entry.item.category} · ` : ''}
              {entry.item.place ?? entry.countryName ?? entry.coords.name}
            </p>
            <h3>{entry.item.label}</h3>
            {heat && entry.item.value !== undefined && <p className="wg-map-detail-value">{withUnit(entry.item.value, entry.item.unit ?? spec.unit)}</p>}
            {entry.item.detail && <p>{entry.item.detail}</p>}
            {entry.item.date && <p className="brief-meta">{entry.item.date}</p>}
            <ItemLink url={entry.item.url} />
          </div>
        )}
      </div>
    </div>
  );
}
