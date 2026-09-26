/**
 * Wake word: in a voice session, Iris only acts on sentences addressed to her by name, at the
 * start ("Iris, tu peux…", "Hey Iris, what's…") or at the end ("Ouvre la calculatrice, Iris.");
 * anything else said around the microphone is ignored.
 *
 * Works on transcripts (local Whisper on standby, OpenAI during a session), so it has to tolerate
 * how speech recognition spells the name.
 */

/** Words that may come before the name: "Hey Iris", "Dis Iris", "OK Iris". */
const INTERJECTIONS = new Set(['hey', 'he', 'eh', 'hi', 'ok', 'okay', 'oh', 'dis', 'allo', 'bon', 'alors', 'salut', 'bonjour', 'yo']);

/** Words that may come after the name at the end: "…, Iris, s'il te plaît", "…, Iris, merci". */
const POLITENESS = new Set(['merci', 'stp', 'svp', 's', 'il', 'te', 'vous', 'plait', 'please', 'thanks', 'thank', 'you']);

/**
 * "Iris" and the ways transcription tends to write it (Irisse, Iriss, Irice, Hiris, Yris, Aïris,
 * I.R.I.S.). "Irish" is left out: it is a real English word.
 */
const NAME = /^(?:h|a|e)?[iy]r[iy](?:s|ss|sse|se|ce|z)$/;

/** Lower case, accents removed, letters only: "I.R.I.S.," → "iris", "Hé" → "he". */
const normalize = (word: string) =>
  word
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');

const NAME_PATTERN = '(?:h|a|e)?[iy]r[iy](?:s|ss|sse|se|ce|z)';
const LEADING = new RegExp(
  `^\\s*(?:(?:hey|h[eé]|eh|hi|ok|okay|oh|dis|all[oô]|bon|alors|salut|bonjour|yo)[\\s,!.]+){0,2}${NAME_PATTERN}\\b[\\s,!.?:;]*`,
  'i',
);
const TRAILING = new RegExp(
  `[\\s,]*\\b${NAME_PATTERN}\\b(?:[\\s,]*(?:merci|stp|svp|s['’]il (?:te|vous) pla[iî]t|please|thanks|thank you))*[\\s.!?]*$`,
  'i',
);

/** The request without the way it addresses Iris: "Iris, ouvre la calculatrice." → "ouvre la calculatrice." */
export function stripAddress(transcript: string): string {
  return transcript.replace(LEADING, '').replace(TRAILING, '').trim();
}

/** True when the name starts (after at most two interjections) or ends the sentence. */
export function isAddressedToIris(transcript: string): boolean {
  // "I.R.I.S." is split on spaces only, so its dots don't break it into letters.
  const words = transcript
    .split(/[\s,;:!?'’]+/)
    .map(normalize)
    .filter(Boolean);
  for (let i = 0; i < Math.min(words.length, 3); i++) {
    if (NAME.test(words[i])) return true;
    if (!INTERJECTIONS.has(words[i])) break;
  }
  for (let i = words.length - 1; i >= Math.max(0, words.length - 5); i--) {
    if (NAME.test(words[i])) return true;
    if (!POLITENESS.has(words[i])) break;
  }
  return false;
}
