/**
 * Categorical colours of the widgets, in fixed order (never cycled), stepped for the HUD's dark
 * surface. Validated (dataviz validate_palette.js, dark, surface #060a04): lightness band, chroma,
 * adjacent CVD ΔE ≥ 8.4, normal-vision ΔE ≥ 19.3, contrast ≥ 3:1. Past eight groups, the rest
 * share the neutral "other" colour. A single series uses the HUD accent (no identity to carry).
 */
import { uiLocale } from '../../../i18n';
export const CATEGORICAL = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
export const OTHER = '#7d8f99';
export const SINGLE = '#76b900';
export const UP = '#a6ff2e';
export const DOWN = '#ff5c7a';

/** Colour per group, by order of first appearance (a group keeps its colour when others are added). */
export function categoryColors(categories: (string | undefined)[]): { colorOf: (c: string | undefined) => string; groups: string[] } {
  const groups: string[] = [];
  for (const c of categories) if (c && !groups.includes(c)) groups.push(c);
  const colorOf = (c: string | undefined) => {
    if (!c) return groups.length ? OTHER : SINGLE;
    const i = groups.indexOf(c);
    return i >= 0 && i < CATEGORICAL.length ? CATEGORICAL[i] : OTHER;
  };
  return { colorOf, groups };
}

const locale = uiLocale;

/** 1234.5 → "1 234,5" (fr); large numbers compact on axes ("12 k"). */
export function formatNumber(v: number, compact = false): string {
  if (compact && Math.abs(v) >= 10_000) return v.toLocaleString(locale(), { notation: 'compact', maximumFractionDigits: 1 });
  const digits = Math.abs(v) >= 100 ? 0 : Math.abs(v) >= 1 ? 2 : 3;
  return v.toLocaleString(locale(), { maximumFractionDigits: digits });
}

/** "12 €", "24 °C", "3,5 %" (the unit after a space, as in French and SI typography). */
export const withUnit = (v: number, unit?: string, compact = false) => (unit ? `${formatNumber(v, compact)} ${unit}` : formatNumber(v, compact));
