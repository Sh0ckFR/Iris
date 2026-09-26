/**
 * Cutting Iris off by just talking. While she speaks, the moment the user starts talking her
 * voice pauses; once the sentence is transcribed, it either was the user (she drops her reply and
 * listens) or not — the echo of her own voice through speakers, a cough, a noise Whisper turned
 * into words — and she carries on where she stopped.
 */

const normalize = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3);

/**
 * What Whisper tends to "hear" in silence or noise (subtitle credits, a lone thanks…): not the
 * user speaking.
 */
const NOISE = /^(merci( beaucoup)?( a tous)?|thank you( for watching)?|thanks|sous titr\w*.*|subtitles? by.*|amara org.*|musique|music|applaudissements|rires|\.+|hmm+|euh+)$/;

export function isNoise(heard: string): boolean {
  const t = heard
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 .]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const bare = t.replace(/[.!?]+$/, '').trim();
  return !bare || NOISE.test(bare);
}

/**
 * Whether what was heard is Iris's own voice coming back through the speakers: most of its
 * words are in what she just said. (A headset has no echo; this is for speakers.)
 */
export function isEcho(heard: string, recentlySpoken: string[]): boolean {
  const words = normalize(heard);
  if (words.length === 0) return false;
  const spoken = new Set(recentlySpoken.flatMap(normalize));
  if (spoken.size === 0) return false;
  const shared = words.filter((w) => spoken.has(w)).length;
  return shared / words.length >= 0.6;
}

/** Whether a sentence heard while Iris was speaking is the user cutting her off. */
export function isInterruption(heard: string, recentlySpoken: string[]): boolean {
  return !isNoise(heard) && !isEcho(heard, recentlySpoken);
}
