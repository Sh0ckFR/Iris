const buffers = new WeakMap<AnalyserNode, Uint8Array<ArrayBuffer>>();

/** Loudness of the analyser's current frame, scaled to roughly 0..1 for speech. */
export function rms(analyser: AnalyserNode): number {
  let buf = buffers.get(analyser);
  if (!buf) {
    buf = new Uint8Array(analyser.fftSize);
    buffers.set(analyser, buf);
  }
  analyser.getByteTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = (buf[i] - 128) / 128;
    sum += v * v;
  }
  return Math.min(1, Math.sqrt(sum / buf.length) * 4);
}

const BOUNDARY = /[.!?…]+["')\]]*\s+|\n+/g;

const CLAUSE = /[,;:—–]\s+/g;

/**
 * Splits streamed text into complete sentences so speech can start before the reply is done.
 * Very short fragments ("Mr.", "3.") are carried over to avoid choppy audio.
 *
 * `firstClause`: nothing has been said of this reply yet — rather than wait for a long first
 * sentence to end, its first clause is said as soon as it is complete ("Bien sûr, …"): the
 * voice starts sooner, and the rest follows while it speaks.
 */
export function splitSentences(buffer: string, { firstClause = false }: { firstClause?: boolean } = {}): [sentences: string[], rest: string] {
  const [sentences, rest] = splitWhole(buffer);
  if (!firstClause || sentences.length || rest.length < 40) return [sentences, rest];
  for (const match of rest.matchAll(CLAUSE)) {
    const end = (match.index ?? 0) + match[0].length;
    if (end < 20) continue;
    if (end > 160) break;
    return [[rest.slice(0, end).trim()], rest.slice(end)];
  }
  return [sentences, rest];
}

function splitWhole(buffer: string): [sentences: string[], rest: string] {
  const out: string[] = [];
  let start = 0;
  let carry = '';
  for (const match of buffer.matchAll(BOUNDARY)) {
    const end = (match.index ?? 0) + match[0].length;
    const piece = carry + buffer.slice(start, end);
    start = end;
    if (piece.trim().length < 12) {
      carry = piece;
      continue;
    }
    out.push(piece.trim());
    carry = '';
  }
  return [out, carry + buffer.slice(start)];
}

/** Strips markdown the model may still emit so the voice doesn't read symbols aloud. */
export function cleanForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_#>~|]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
