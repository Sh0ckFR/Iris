/**
 * Short spoken acknowledgements, said while the AI works on a spoken request ("Je regarde ça,
 * monsieur."), so Iris answers at once. A fixed, small set: each one is
 * synthesized once and replayed from memory (see Speaker.enqueueCached), so they cost no tokens
 * and, after the first time, no voice characters either.
 */

type Kind = 'default' | 'search' | 'computer' | 'create';

const PHRASES: Record<'fr' | 'en', Record<Kind, string[]>> = {
  fr: {
    default: ['Un instant{h}.', 'Tout de suite{h}.'],
    search: ['Je regarde ça{h}.', 'Je vérifie{h}.'],
    computer: ['Je m’en occupe{h}.', 'C’est parti{h}.'],
    create: ['Je vous prépare ça{h}.', 'Je m’y mets{h}.'],
  },
  en: {
    default: ['One moment{h}.', 'Right away{h}.'],
    search: ['Let me check{h}.', 'Looking into it{h}.'],
    computer: ['On it{h}.', 'Right away{h}.'],
    create: ['Preparing it now{h}.', 'Coming right up{h}.'],
  },
};

function kindOf(toolName: string | null): Kind {
  if (!toolName) return 'default';
  if (/^(search_web|read_webpage|get_news|lookup_wikipedia|get_weather|get_stock_quote|recall_memory|look_at_screen|mcp_)/.test(toolName)) return 'search';
  if (/^(create_visual|generate_image|show_data|create_skill)/.test(toolName)) return 'create';
  return 'computer';
}

/** ", monsieur" / ", sir" when the user set an honorific (see Settings), else nothing. */
function address(honorific: string, lang: 'fr' | 'en'): string {
  const h = honorific.trim();
  if (!h) return '';
  const english: Record<string, string> = { monsieur: 'sir', madame: "ma'am", mademoiselle: 'miss' };
  const word = lang === 'en' ? (english[h.toLowerCase()] ?? h) : /^(monsieur|madame|mademoiselle)$/i.test(h) ? h.toLowerCase() : h;
  return `, ${word}`;
}

/** A phrase for the tool being run (null: the model is still thinking). */
export function acknowledgement(toolName: string | null, lang: 'fr' | 'en', honorific: string): string {
  const options = PHRASES[lang][kindOf(toolName)];
  return options[Math.floor(Math.random() * options.length)].replace('{h}', address(honorific, lang));
}

/** Every phrase, to synthesize them ahead of time. */
export function allAcknowledgements(lang: 'fr' | 'en', honorific: string): string[] {
  return [...new Set(Object.values(PHRASES[lang]).flat())].map((p) => p.replace('{h}', address(honorific, lang)));
}
