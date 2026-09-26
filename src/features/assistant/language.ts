/**
 * Which language is the user speaking? Iris must answer in it, but the models drift to
 * English: the instructions and the tool results (weather summaries, web pages…) are English.
 * A per-turn hint ("the user is speaking French") keeps them on track.
 */

const FR_WORDS = new Set(
  (
    'je tu il elle nous vous ils elles moi te toi le la les un une des du de au aux ce cet cette ces ' +
    'est sont suis es sommes êtes ai as avons avez ont était et ou mais donc car ni que qui quoi quel quelle ' +
    'quels quelles comment pourquoi combien quand où pour par avec sans sur sous dans chez pas plus ' +
    'très bien oui non merci salut bonjour bonsoir peux peut pouvez veux voudrais fais faire fait dis donne ' +
    'montre ouvre cherche mon ma mes ton ta tes son sa ses notre votre leur aujourd hui demain actualités météo'
  ).split(' '),
);

const EN_WORDS = new Set(
  (
    // Words that are also French ("a", "on", "me", "son"…) are left out.
    'i you he she we they my your his her our their the of to in at for with from by about ' +
    'is are am was were be been do does did have has had can could would will should what which who how ' +
    'why when where and or but not no yes please thanks thank hello hi hey show open tell give find search ' +
    'today tomorrow news weather it this that these those there'
  ).split(' '),
);

/**
 * Best guess between French and English, or null when the text is too short or mixed to tell
 * (a name, "ok", a URL…). Deliberately limited to fr/en: other languages are left to the model.
 */
export function detectLanguage(text: string): 'fr' | 'en' | null {
  const words = text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .split(/[^a-zà-öø-ÿœ']+/i) // hyphens split too: "donne-moi", "est-ce"
    .flatMap((w) => w.split(/['’]/))
    .filter(Boolean);
  let fr = 0;
  let en = 0;
  for (const w of words) {
    if (FR_WORDS.has(w)) fr++;
    if (EN_WORDS.has(w)) en++;
  }
  // Accents and elisions (c', l', qu'…) are strong French signals.
  fr += (text.match(/[éèêàçùûôîœ]/gi)?.length ?? 0) * 0.5;
  fr += (text.match(/\b(?:c|l|d|j|m|n|s|t|qu)['’]/gi)?.length ?? 0);
  if (fr + en < 1.5) return null;
  if (fr >= en * 1.5 && fr - en >= 1) return 'fr';
  if (en >= fr * 1.5 && en - fr >= 1) return 'en';
  return null;
}

/** "fr" → "French" (the instructions are written in English). */
export function languageName(code: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** Hint appended to the instructions once the user's language is known. */
export function languageHint(code: string | null): string {
  if (!code) return '';
  const name = languageName(code);
  return `The user is currently speaking ${name}: reply in ${name}, even if tool results or documents are in another language.`;
}
