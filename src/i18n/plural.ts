/** Plural forms of one phrase ("#" stands for the number), chosen by the language's own rules. */
export type PluralForms = Partial<Record<Intl.LDMLPluralRule, string>> & { other: string };

/** `plural('ru')(3, { one: '# место', few: '# места', many: '# мест', other: '# места' })` → "3 места". */
export const plural = (locale: string) => {
  const rules = new Intl.PluralRules(locale);
  return (n: number, forms: PluralForms) => (forms[rules.select(n)] ?? forms.other).replace('#', n.toLocaleString(locale));
};
