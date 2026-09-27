/**
 * Faster answers to speech (localWake.ts). The voice activity detector only declares a sentence
 * over after 0.7 s of silence, and Whisper then needs a few hundred ms more. So at the first
 * short pause (~0.25 s) the sentence so far is transcribed *speculatively*:
 *  - if the user said nothing more, that transcript is the sentence's: it is ready (or nearly)
 *    when the detector ends it — and a sentence that clearly ends ("…?", "….") doesn't even wait
 *    for the full pause (committed after ~0.4 s);
 *  - if they go on, it is dropped (a new one starts at the next pause) — and when it already
 *    says "Iris…", Iris knows she is being addressed before the sentence is over.
 * This file tracks one sentence's frames; it knows nothing of Whisper or the detector.
 */

/** The detector's frames: 512 samples at 16 kHz. */
export const FRAME_MS = 32;
/** The detector's thresholds (vad-web's defaults for Silero v5). */
const SPEECH = 0.3;
const SILENCE = 0.25;
/** Pause that starts a speculative transcription (~0.26 s). */
const PAUSE_FRAMES = 8;
/**
 * Pause after which a clearly finished sentence is committed (~0.55 s, instead of the detector's
 * 0.7 s). Shorter cut people off at their natural pauses ("Iris… [breath] mets de la musique").
 */
const COMMIT_FRAMES = 17;
/** Some speech first (~0.35 s): not every breath. */
const MIN_SPEECH_FRAMES = 11;
/** At most this many speculative transcriptions per sentence (people pausing mid-sentence). */
const MAX_SPECULATIONS = 3;

/** Ends a sentence ("…" doesn't: the user trails off and goes on). */
const FINISHED = /[.?!？。！]["»”’)\]]*$/;

/**
 * Whisper puts a full stop after almost anything, "Iris." included: a sentence is only
 * committed early when it says something besides her name (a request is at least two words).
 */
function saysSomething(text: string): boolean {
  const words = text
    .replace(/\b(iris|hiris|irisse|yris)\b/gi, ' ')
    .split(/\s+/)
    .filter((w) => /\p{L}/u.test(w));
  return words.length >= 2;
}

interface Speculation {
  /** Frames it covers. */
  frames: number;
  promise: Promise<string | null>;
  /** Set once known (undefined while Whisper works). */
  result?: string | null;
}

export class Utterance {
  readonly frames: Float32Array[];
  /** Frames up to the last one with speech. */
  private lastSpeech: number;
  private speechFrames = 0;
  private silence = 0;
  private speculations = 0;
  lastSpeechAt: number;
  spec: Speculation | null = null;
  /** Frames already delivered as a sentence (committed before the detector's end). */
  committed: number | null = null;

  constructor(
    preSpeech: Float32Array[],
    readonly startedAt: number,
  ) {
    this.frames = [...preSpeech];
    this.lastSpeech = this.frames.length;
    this.lastSpeechAt = startedAt;
  }

  push(frame: Float32Array, probability: number, now: number) {
    this.frames.push(frame);
    if (probability >= SPEECH) {
      this.speechFrames++;
      this.silence = 0;
      this.lastSpeech = this.frames.length;
      this.lastSpeechAt = now;
      // Speech after the speculation started: it no longer covers the sentence.
      if (this.spec && this.spec.frames < this.lastSpeech) this.spec = null;
    } else if (probability < SILENCE) {
      this.silence++;
    }
  }

  /** A pause long enough, after enough speech, and no transcription in progress for it. */
  wantsSpeculation(): boolean {
    return !this.spec && this.committed === null && this.speculations < MAX_SPECULATIONS && this.silence >= PAUSE_FRAMES && this.speechFrames >= MIN_SPEECH_FRAMES;
  }

  speculate(transcribe: (audio: Float32Array) => Promise<string | null>): Speculation {
    this.speculations++;
    const spec: Speculation = { frames: this.frames.length, promise: transcribe(this.audioSince(0)) };
    spec.promise.then(
      (text) => (spec.result = text),
      () => (spec.result = null),
    );
    this.spec = spec;
    return spec;
  }

  /** The speculative transcript still covers everything said (nothing since it started). */
  specCurrent(): boolean {
    return !!this.spec && this.lastSpeech <= this.spec.frames;
  }

  /** The sentence's text when it can be delivered now, before the detector's full pause. */
  readyToCommit(): string | null {
    if (this.committed !== null || !this.specCurrent() || this.silence < COMMIT_FRAMES) return null;
    const text = this.spec?.result?.trim();
    return text && FINISHED.test(text) && saysSomething(text) ? text : null;
  }

  /** Said something after the commit (to be heard as a new sentence). */
  spokeAfterCommit(): boolean {
    return this.committed !== null && this.lastSpeech > this.committed;
  }

  audioSince(frame: number): Float32Array {
    const parts = this.frames.slice(frame);
    const out = new Float32Array(parts.reduce((n, f) => n + f.length, 0));
    let at = 0;
    for (const f of parts) {
      out.set(f, at);
      at += f.length;
    }
    return out;
  }
}
