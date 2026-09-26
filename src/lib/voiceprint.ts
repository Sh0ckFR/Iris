import { useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { AsrRequest, AsrResponse } from '../features/assistant/localAsr.worker';

/**
 * Voice recognition, on this computer only. Each recorded voice is kept as a voiceprint — the
 * average of a few 256-number speaker embeddings (a ResNet34 speaker model), never the recording — in
 * `<app data>/memory/voices.json`. When Iris listens only to known voices, a sentence is kept
 * if it sounds like one of them; in a longer sentence, only the stretches in a known voice are
 * kept (someone else talking around the request is cut out before it is transcribed again).
 */

export interface VoiceProfile {
  id: string;
  name: string;
  /** Unit-length average of the enrollment samples' embeddings. */
  vector: number[];
  createdAt: number;
}

const FILE = 'voices';
/**
 * Same speaker above this cosine similarity (whole sentence). Measured: the same voice on two
 * different sentences ≈ 0.83, two different voices ≈ 0.1 — the threshold sits between, with room
 * for a noisier microphone. Every check is logged, to tune.
 */
const MATCH = 0.55;
/** For 1.5 s windows, which carry less of the voice. */
const WINDOW_MATCH = 0.5;
const RATE = 16_000;
const WINDOW = 1.5 * RATE;
const HOP = 0.75 * RATE;
/** Up to this length a sentence is checked whole. */
const WHOLE_MAX = 2.5 * RATE;

// ------------------------------------------------------------------ store

let voices: VoiceProfile[] = [];
let loaded: Promise<void> | null = null;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((l) => l());
const save = () =>
  void invoke('memory_write', { name: FILE, content: JSON.stringify(voices) }).catch((error) => console.warn('[iris:voices] could not save', error));

const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function normalize(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

function average(vectors: number[][]): number[] {
  const sum = new Array<number>(vectors[0].length).fill(0);
  for (const v of vectors) normalize(v).forEach((x, i) => (sum[i] += x));
  return normalize(sum);
}

const cosine = (a: number[], b: number[]) => {
  const na = normalize(a);
  return na.reduce((s, x, i) => s + x * b[i], 0);
};

export const voiceStore = {
  load(): Promise<void> {
    loaded ??= invoke<string | null>('memory_read', { name: FILE })
      .then((raw) => {
        voices = raw ? (JSON.parse(raw) as VoiceProfile[]) : [];
        changed();
      })
      .catch((error) => console.warn('[iris:voices] could not read', error));
    return loaded;
  },
  get all() {
    return voices;
  },
  /** A new voice from its recorded samples' embeddings. */
  add(name: string, samples: number[][]): VoiceProfile {
    const profile = { id: uid(), name: name.trim() || 'Voice', vector: average(samples), createdAt: Date.now() };
    voices = [...voices, profile];
    save();
    changed();
    return profile;
  },
  /** Records a voice again (same name). */
  replace(id: string, samples: number[][]) {
    voices = voices.map((v) => (v.id === id ? { ...v, vector: average(samples), createdAt: Date.now() } : v));
    save();
    changed();
  },
  rename(id: string, name: string) {
    voices = voices.map((v) => (v.id === id ? { ...v, name: name.trim() || v.name } : v));
    save();
    changed();
  },
  remove(id: string) {
    voices = voices.filter((v) => v.id !== id);
    save();
    changed();
  },
};

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

export function useVoices(): VoiceProfile[] {
  return useSyncExternalStore(subscribe, () => voices);
}

// ------------------------------------------------------------------ embeddings (worker)

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (v: number[]) => void; reject: (e: Error) => void }>();

/** The voiceprint of a stretch of 16 kHz speech (the speaker model is downloaded on first use). */
export function embed(audio: Float32Array): Promise<number[]> {
  if (!worker) {
    worker = new Worker(new URL('../features/assistant/localAsr.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<AsrResponse>) => {
      const msg = e.data;
      if (msg.type === 'embedding') {
        pending.get(msg.id)?.resolve(msg.vector);
        pending.delete(msg.id);
      } else if (msg.type === 'error' && msg.id !== undefined) {
        pending.get(msg.id)?.reject(new Error(msg.message));
        pending.delete(msg.id);
      }
    };
    worker.onerror = (e) => {
      pending.forEach((p) => p.reject(new Error(e.message || 'voice recognition stopped')));
      pending.clear();
      worker = null;
    };
  }
  const id = ++seq;
  const copy = audio.slice(); // transferred to the worker
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker!.postMessage({ type: 'embed', id, audio: copy } satisfies AsrRequest, [copy.buffer]);
  });
}

/** Loads the speaker model ahead (a first check would otherwise wait for the download). */
export function warmVoiceRecognition() {
  void embed(new Float32Array(RATE)).catch(() => {});
}

/** The best known voice for this embedding. */
function bestMatch(vector: number[]): { voice: VoiceProfile; score: number } | null {
  let best: { voice: VoiceProfile; score: number } | null = null;
  for (const voice of voices) {
    const score = cosine(vector, voice.vector);
    if (!best || score > best.score) best = { voice, score };
  }
  return best;
}

export interface VoiceCheck {
  /** `all`: a known voice throughout; `part`: only `audio` is in a known voice; `none`: unknown. */
  kept: 'all' | 'part' | 'none';
  audio: Float32Array;
  name?: string;
  score: number;
}

/**
 * Keeps what a known voice said. A short sentence is judged whole; a longer one window by window
 * (1.5 s, overlapping), and the windows in a known voice are joined back together.
 */
export async function keepKnownVoices(audio: Float32Array): Promise<VoiceCheck> {
  if (audio.length <= WHOLE_MAX) {
    const match = bestMatch(await embed(audio));
    const score = match?.score ?? 0;
    return score >= MATCH ? { kept: 'all', audio, name: match!.voice.name, score } : { kept: 'none', audio: new Float32Array(0), score };
  }
  const starts: number[] = [];
  for (let s = 0; s + WINDOW <= audio.length; s += HOP) starts.push(s);
  if (starts[starts.length - 1] + WINDOW < audio.length) starts.push(audio.length - WINDOW);
  const known: boolean[] = [];
  let best = 0;
  let name: string | undefined;
  for (const start of starts) {
    const match = bestMatch(await embed(audio.subarray(start, start + WINDOW)));
    const score = match?.score ?? 0;
    known.push(score >= WINDOW_MATCH);
    if (score > best) {
      best = score;
      name = match?.voice.name;
    }
  }
  if (known.every(Boolean)) return { kept: 'all', audio, name, score: best };
  if (!known.some(Boolean)) return { kept: 'none', audio: new Float32Array(0), score: best };
  // Join the known windows (overlapping ones merge into one stretch).
  const keep = new Uint8Array(audio.length);
  starts.forEach((start, i) => known[i] && keep.fill(1, start, Math.min(audio.length, start + WINDOW)));
  const out = new Float32Array(keep.reduce((n, k) => n + k, 0));
  for (let i = 0, j = 0; i < audio.length; i++) if (keep[i]) out[j++] = audio[i];
  return { kept: 'part', audio: out, name, score: best };
}

// ------------------------------------------------------------------ recording (enrollment)

/** While a voice is being recorded, what is said is not a request to Iris. */
let enrolling = false;
export const isEnrolling = () => enrolling;

/**
 * Records `ms` of microphone audio at 16 kHz (for a voice's samples), reporting the level (0..1).
 * Leading and trailing silence are trimmed.
 */
export async function recordSample(ms: number, onLevel: (level: number) => void): Promise<Float32Array> {
  enrolling = true;
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const ctx = new AudioContext();
  try {
    const source = ctx.createMediaStreamSource(stream);
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    const chunks: Float32Array[] = [];
    processor.onaudioprocess = (e) => {
      const data = e.inputBuffer.getChannelData(0);
      chunks.push(data.slice());
      let sum = 0;
      for (const x of data) sum += x * x;
      onLevel(Math.min(1, Math.sqrt(sum / data.length) * 4));
    };
    source.connect(processor);
    processor.connect(ctx.destination);
    await new Promise((r) => setTimeout(r, ms));
    processor.disconnect();
    source.disconnect();
    const raw = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
    chunks.reduce((offset, c) => (raw.set(c, offset), offset + c.length), 0);
    return trimSilence(resample(raw, ctx.sampleRate, RATE));
  } finally {
    onLevel(0);
    stream.getTracks().forEach((t) => t.stop());
    void ctx.close();
    // The last words may still be in the listener's pipeline: let them pass before listening again.
    window.setTimeout(() => (enrolling = false), 1500);
  }
}

function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const x = i * ratio;
    const i0 = Math.floor(x);
    const i1 = Math.min(input.length - 1, i0 + 1);
    out[i] = input[i0] + (input[i1] - input[i0]) * (x - i0);
  }
  return out;
}

/** Cuts silent 20 ms frames at both ends. */
function trimSilence(audio: Float32Array): Float32Array {
  const frame = RATE / 50;
  const loud = (start: number) => {
    let sum = 0;
    for (let i = start; i < Math.min(audio.length, start + frame); i++) sum += audio[i] * audio[i];
    return Math.sqrt(sum / frame) > 0.01;
  };
  let start = 0;
  while (start < audio.length && !loud(start)) start += frame;
  let end = audio.length;
  while (end > start && !loud(end - frame)) end -= frame;
  return audio.subarray(Math.max(0, start - frame * 5), Math.min(audio.length, end + frame * 5));
}

/** Enough voice in a sample to learn from (at least a second of speech). */
export const hasEnoughSpeech = (audio: Float32Array) => audio.length >= RATE;
