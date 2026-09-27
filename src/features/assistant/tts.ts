import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import type { Language } from '../../lib/settings';
import { recordTts } from '../../lib/usage';
import { cleanForSpeech, rms } from './audio';
import { detectLanguage } from './language';
import type { TtsRequest, TtsResponse } from './localTts.worker';

/**
 * Reads replies aloud with the natural voice of the provider Iris is connected to (OpenAI or
 * Gemini text-to-speech), or a free voice computed on this computer. Sentence by sentence: each sentence is synthesized as soon as it is complete, so
 * speech starts before the reply is finished. Played through Web Audio so the eye reacts to
 * the real waveform.
 *
 * Several tasks can answer at once: each speaks on its own *channel*. Channels never overlap —
 * the first one to produce a sentence speaks until its reply is over, then the next one (which
 * has been synthesizing in the meantime) takes its turn.
 */

/** Who speaks: OpenAI or Gemini text-to-speech (with that provider's key), or Piper on this computer. */
export type SpeechEngine = 'openai' | 'google' | 'local';

export interface SpeakerConfig {
  apiKey?: string;
  /** A voice of the engine: an OpenAI voice ("marin") or a Gemini one ("Sulafat"). */
  voice: string;
  language: Language;
  engine: SpeechEngine;
}

/** Local Piper voices: female, like Iris (British for English). */
const LOCAL_VOICES: Record<'fr' | 'en', string> = { fr: 'fr_FR-siwis-medium', en: 'en_GB-jenny_dioco-medium' };

let localWorker: Worker | null = null;
let localSeq = 0;
const localPending = new Map<number, { resolve: (wav: ArrayBuffer) => void; reject: (error: Error) => void }>();

/** A sentence is given up past this: the first one includes downloading the voice (~60 MB). */
const LOCAL_TIMEOUT_MS = 120_000;

/** Fails every sentence waiting on the worker (it crashed or hung), and starts a fresh one next time. */
function failLocalWorker(reason: string) {
  console.warn(`[iris:tts] local voice failed: ${reason}`);
  localPending.forEach((p) => p.reject(new Error(`Local voice failed: ${reason}`)));
  localPending.clear();
  localWorker?.terminate();
  localWorker = null;
}

/** Synthesizes one sentence with Piper in a worker; resolves with WAV bytes. */
function synthesizeLocally(text: string, voiceId: string): Promise<ArrayBuffer> {
  if (!localWorker) {
    localWorker = new Worker(new URL('./localTts.worker.ts', import.meta.url), { type: 'module' });
    localWorker.onerror = (e) => failLocalWorker(e.message || 'the worker stopped');
    localWorker.onmessage = (e: MessageEvent<TtsResponse>) => {
      const msg = e.data;
      if ('progress' in msg) {
        if (msg.progress % 10 === 0) console.warn(`[iris:tts] downloading local voice… ${msg.progress} %`);
        return;
      }
      if ('log' in msg) {
        console.warn(`[iris:tts] ${msg.log}`);
        return;
      }
      if (msg.id === -1 && 'error' in msg) {
        failLocalWorker(msg.error);
        return;
      }
      const pending = localPending.get(msg.id);
      localPending.delete(msg.id);
      if ('wav' in msg) pending?.resolve(msg.wav);
      else pending?.reject(new Error(`Local voice failed: ${msg.error}`));
    };
  }
  const id = ++localSeq;
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      if (localPending.has(id)) failLocalWorker('no answer from the local voice (timed out)');
    }, LOCAL_TIMEOUT_MS);
    localPending.set(id, {
      resolve: (wav) => (window.clearTimeout(timer), resolve(wav)),
      reject: (error) => (window.clearTimeout(timer), reject(error)),
    });
    localWorker!.postMessage({ id, text, voiceId } satisfies TtsRequest);
  });
}

interface SpeakerCallbacks {
  onLevel: (level: number) => void;
  /** Audio playing (true) or everything spoken (false). */
  onBusy: (busy: boolean) => void;
  onError: (error: Error) => void;
  /** A sentence starts being heard (the map follows the places Iris names). */
  onSentence?: (text: string, channel: string) => void;
}

/**
 * Speech that arrives as it is synthesized (OpenAI streams raw 24 kHz PCM): playback starts with
 * the first chunk instead of waiting for the whole sentence — a second or more saved each time.
 */
export class PcmStream {
  readonly sampleRate = 24_000;
  chunks: Float32Array[] = [];
  done = false;
  error: Error | null = null;
  private wake: (() => void) | null = null;

  push(samples: Float32Array) {
    if (samples.length) this.chunks.push(samples);
    this.notify();
  }

  end(error?: unknown) {
    this.done = true;
    if (error) this.error = error instanceof Error ? error : new Error(String(error));
    this.notify();
  }

  /** Resolves when there is audio to take, or nothing more will come. */
  ready(): Promise<void> {
    if (this.chunks.length || this.done) return Promise.resolve();
    return new Promise((resolve) => (this.wake = resolve));
  }

  /** Everything received so far, as one block. */
  take(): Float32Array<ArrayBuffer> | null {
    if (!this.chunks.length) return null;
    const total = this.chunks.reduce((n, c) => n + c.length, 0);
    const out = new Float32Array(total);
    let at = 0;
    for (const c of this.chunks) {
      out.set(c, at);
      at += c.length;
    }
    this.chunks = [];
    return out;
  }

  private notify() {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }
}

/** 16-bit little-endian PCM → samples; an odd trailing byte is carried to the next chunk. */
export function pcm16ToFloat(bytes: Uint8Array, carry: number | null): { samples: Float32Array; carry: number | null } {
  const all = carry === null ? bytes : Uint8Array.of(carry, ...bytes);
  const count = Math.floor(all.length / 2);
  const samples = new Float32Array(count);
  const view = new DataView(all.buffer, all.byteOffset, count * 2);
  for (let i = 0; i < count; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
  return { samples, carry: all.length % 2 ? all[all.length - 1] : null };
}

type Playable = AudioBuffer | PcmStream;

interface Channel {
  /** Requested as soon as a sentence is queued, so it's ready when its turn comes. */
  items: { audio: Promise<Playable>; text: string }[];
  /** No more sentences will be added. */
  ended: boolean;
  waiters: Array<() => void>;
}

const TTS_MODEL = 'gpt-4o-mini-tts';
const DELIVERY =
  'Voice of Iris: calm, courteous and precise, with a subtle dry wit. Natural pace, warm but understated.';

/** Gemini's speech model when the key's list can't be read. */
const GEMINI_TTS_FALLBACK = 'gemini-2.5-flash-preview-tts';
/** How Gemini should say it (a speech model reads the direction, then speaks the text after it). */
const GEMINI_DIRECTION = 'Say in a calm, warm and courteous voice, at a natural pace:';

const geminiTtsModels = new Map<string, Promise<string>>();

/** The newest Gemini text-to-speech model this key can use (flash first: faster). */
function geminiTtsModel(apiKey: string): Promise<string> {
  let model = geminiTtsModels.get(apiKey);
  if (!model) {
    model = (async () => {
      try {
        const response = await tauriFetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000', {
          headers: { 'x-goog-api-key': apiKey },
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) return GEMINI_TTS_FALLBACK;
        const data = (await response.json()) as { models?: { name: string; supportedGenerationMethods?: string[] }[] };
        const version = (id: string) => Number(/(\d+(?:\.\d+)?)/.exec(id)?.[1] ?? 0);
        const tts = (data.models ?? [])
          .map((m) => ({ id: m.name.replace(/^models\//, ''), methods: m.supportedGenerationMethods ?? [] }))
          .filter((m) => /tts/i.test(m.id) && m.methods.includes('generateContent'))
          .sort((a, b) => Number(/flash/.test(b.id)) - Number(/flash/.test(a.id)) || version(b.id) - version(a.id));
        return tts[0]?.id ?? GEMINI_TTS_FALLBACK;
      } catch {
        return GEMINI_TTS_FALLBACK;
      }
    })();
    geminiTtsModels.set(apiKey, model);
  }
  return model;
}

/** Gemini speaks raw 16-bit PCM ("audio/L16;codec=pcm;rate=24000"): made into an AudioBuffer here. */
function pcmToBuffer(ctx: AudioContext, base64: string, mimeType: string): AudioBuffer {
  const rate = Number(/rate=(\d+)/.exec(mimeType)?.[1] ?? 24_000);
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const samples = new Int16Array(bytes.buffer, 0, Math.floor(bytes.length / 2));
  const buffer = ctx.createBuffer(1, samples.length, rate);
  const channel = buffer.getChannelData(0);
  for (let i = 0; i < samples.length; i++) channel[i] = samples[i] / 32768;
  return buffer;
}

export function speechLang(language: Language): 'fr' | 'en' {
  if (language === 'multi') return navigator.language.startsWith('fr') ? 'fr' : 'en';
  return language;
}

export class Speaker {
  private config: SpeakerConfig = { voice: 'marin', language: 'en', engine: 'local' };
  private channels = new Map<string, Channel>();
  /** Speaking order: the first channel owns the voice. */
  private order: string[] = [];
  private pumping = false;
  private busy = false;
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private source: AudioBufferSourceNode | null = null;
  private playingChannel: string | null = null;
  /** Channels the user silenced: their remaining sentences are dropped, not spoken later. */
  private muted = new Set<string>();
  private raf = 0;
  private warned = false;

  constructor(private readonly cb: SpeakerCallbacks) {}

  configure(config: SpeakerConfig) {
    if (config.apiKey !== this.config.apiKey) this.warned = false;
    this.config = config;
  }

  get available() {
    return this.config.engine === 'local' || !!this.config.apiKey;
  }

  /** Queues a sentence on a channel (one channel per task). */
  enqueue(raw: string, channel = 'main') {
    const text = cleanForSpeech(raw);
    if (!text || !this.available || this.muted.has(channel)) return;
    const audio = this.synthesize(text, true);
    audio.catch(() => {}); // reported when played
    this.channel(channel).items.push({ audio, text });
    void this.pump();
  }

  /**
   * Like enqueue, for a phrase said again and again (acknowledgements): synthesized once per voice,
   * then replayed from memory — instant, and no more voice characters billed.
   */
  enqueueCached(raw: string, channel = 'main') {
    const text = cleanForSpeech(raw);
    if (!text || !this.available || this.muted.has(channel)) return;
    this.channel(channel).items.push({ audio: this.cachedAudio(text), text });
    void this.pump();
  }

  /** Synthesizes these phrases ahead of time, so their first use is instant too. */
  prewarm(phrases: string[]) {
    if (!this.available) return;
    for (const p of phrases) this.cachedAudio(cleanForSpeech(p)).catch(() => {});
  }

  private readonly phraseCache = new Map<string, Promise<AudioBuffer>>();

  private cachedAudio(text: string): Promise<AudioBuffer> {
    const key = `${this.config.engine}|${this.config.voice}|${text}`;
    let audio = this.phraseCache.get(key);
    if (!audio) {
      // Kept whole (not streamed): it is played again and again.
      audio = this.synthesize(text, false) as Promise<AudioBuffer>;
      audio.catch(() => this.phraseCache.delete(key)); // not remembered when it failed
      this.phraseCache.set(key, audio);
    }
    return audio;
  }

  /** The channel's reply is complete; resolves once it has been fully spoken (or cancelled). */
  end(channel = 'main'): Promise<void> {
    const ch = this.channels.get(channel);
    if (!ch) return Promise.resolve();
    ch.ended = true;
    const done = new Promise<void>((resolve) => ch.waiters.push(resolve));
    void this.pump();
    return done;
  }

  /** Silences one channel (its task was cancelled). */
  cancel(channel: string) {
    const ch = this.channels.get(channel);
    if (!ch) return;
    this.channels.delete(channel);
    this.order = this.order.filter((c) => c !== channel);
    ch.waiters.forEach((resolve) => resolve());
    if (this.playingChannel === channel) this.stopSource();
    void this.pump();
  }

  /**
   * "Stop talking": silences these channels for good (their tasks keep running and their text
   * still appears, but nothing more is said), plus everything currently queued.
   */
  mute(channels: Iterable<string> = []) {
    for (const id of [...channels, ...this.channels.keys()]) {
      this.muted.add(id);
      this.cancel(id);
    }
    this.stopSource();
    // The audio was suspended by hold(): resume it, the next reply must be heard.
    this.release();
  }

  /** Silences everything. */
  stop() {
    for (const id of [...this.channels.keys()]) this.cancel(id);
    this.stopSource();
    this.release();
  }

  /** Paused because the user started talking (the audio is suspended exactly where it was). */
  private held = false;

  /**
   * Pauses Iris's voice at once — the user started talking over her. `release()` carries on
   * from the same syllable; `mute()` drops what was left. False when she wasn't speaking.
   */
  hold(): boolean {
    if (!this.busy || this.held || !this.ctx) return false;
    this.held = true;
    void this.ctx.suspend();
    return true;
  }

  release() {
    if (!this.held) return;
    this.held = false;
    void this.ctx?.resume();
  }

  get isHeld() {
    return this.held;
  }

  dispose() {
    this.stop();
    void this.ctx?.close();
    this.ctx = null;
  }

  private channel(id: string): Channel {
    let ch = this.channels.get(id);
    if (!ch) {
      ch = { items: [], ended: false, waiters: [] };
      this.channels.set(id, ch);
      this.order.push(id);
    }
    return ch;
  }

  private stopSource() {
    try {
      this.source?.stop();
    } catch {
      // already stopped
    }
    this.source = null;
    // A streamed sentence: its scheduled pieces, and the loop feeding them.
    this.playToken++;
    this.streamSources.forEach((s) => {
      try {
        s.stop();
      } catch {
        // already stopped
      }
    });
    this.streamSources.clear();
    this.stopWaiters.forEach((wake) => wake());
    this.stopWaiters.clear();
  }

  /** Changes when playback is stopped: a streamed sentence still arriving stops being fed. */
  private playToken = 0;
  private streamSources = new Set<AudioBufferSourceNode>();
  /** A streamed sentence waiting for its next block (a stalled network must not block "stop"). */
  private stopWaiters = new Set<() => void>();

  private setBusy(value: boolean) {
    if (this.busy === value) return;
    this.busy = value;
    this.cb.onBusy(value);
  }

  private async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.order.length) {
        const id = this.order[0];
        const ch = this.channels.get(id);
        if (!ch) {
          this.order.shift();
          continue;
        }
        const next = ch.items.shift();
        if (!next) {
          if (!ch.ended) break; // the owner is still thinking: wait for its next sentence
          this.channels.delete(id);
          this.order.shift();
          ch.waiters.forEach((resolve) => resolve());
          continue;
        }
        this.setBusy(true);
        try {
          const buffer = await next.audio;
          if (this.channels.get(id) !== ch) continue; // cancelled while synthesizing
          this.playingChannel = id;
          this.cb.onSentence?.(next.text, id);
          await this.play(buffer);
        } catch (err) {
          if (!this.warned) {
            this.warned = true;
            this.cb.onError(err instanceof Error ? err : new Error(String(err)));
          }
        } finally {
          this.playingChannel = null;
        }
      }
    } finally {
      this.pumping = false;
      this.setLevelSource(null);
      if (this.order.length === 0) this.setBusy(false);
    }
  }

  private audioGraph() {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 512;
      this.analyser.connect(this.ctx.destination);
    }
    // (Not while held: synthesizing the next sentence must not wake the paused voice.)
    if (this.ctx.state === 'suspended' && !this.held) void this.ctx.resume();
    return { ctx: this.ctx, analyser: this.analyser! };
  }

  /** `stream`: OpenAI's voice may be played while it arrives (a PcmStream). */
  private async synthesize(text: string, stream: boolean): Promise<Playable> {
    if (this.config.engine === 'local') {
      // Each sentence in its own language: replies may mix French and English names.
      const lang = detectLanguage(text) ?? speechLang(this.config.language);
      return this.audioGraph().ctx.decodeAudioData(await synthesizeLocally(text, LOCAL_VOICES[lang]));
    }
    recordTts(text.length);
    if (this.config.engine === 'google') return this.synthesizeWithGemini(text);
    const response = await tauriFetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: TTS_MODEL, voice: this.config.voice, input: text, instructions: DELIVERY, response_format: stream ? 'pcm' : 'mp3' }),
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 160);
      throw new Error(`OpenAI voice failed (${response.status}). ${detail}`);
    }
    if (!stream) return this.audioGraph().ctx.decodeAudioData(await response.arrayBuffer());
    const pcm = new PcmStream();
    const reader = response.body?.getReader();
    if (!reader) {
      pcm.push(pcm16ToFloat(new Uint8Array(await response.arrayBuffer()), null).samples);
      pcm.end();
      return pcm;
    }
    void (async () => {
      let carry: number | null = null;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const converted = pcm16ToFloat(value, carry);
          carry = converted.carry;
          pcm.push(converted.samples);
        }
        pcm.end();
      } catch (error) {
        pcm.end(error);
      }
    })();
    return pcm;
  }

  private async synthesizeWithGemini(text: string): Promise<AudioBuffer> {
    const apiKey = this.config.apiKey!;
    const model = await geminiTtsModel(apiKey);
    const response = await tauriFetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `${GEMINI_DIRECTION} ${text}` }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: this.config.voice } } },
        },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 160);
      throw new Error(`Gemini voice failed (${response.status}). ${detail}`);
    }
    const data = (await response.json()) as {
      candidates?: { content?: { parts?: { inlineData?: { data?: string; mimeType?: string } }[] } }[];
    };
    const audio = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData;
    if (!audio?.data) throw new Error('Gemini voice returned no audio.');
    return pcmToBuffer(this.audioGraph().ctx, audio.data, audio.mimeType ?? '');
  }

  private async play(audio: Playable): Promise<void> {
    const { ctx, analyser } = this.audioGraph();
    // A context the webview keeps suspended (audio blocked until a click) would never end the
    // sentence: say so and move on, instead of waiting forever with every reply queued behind.
    if (ctx.state !== 'running' && !this.held) {
      await Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, 3000))]);
      // (Re-read after the wait: resume() changes it.)
      if ((ctx.state as AudioContextState) !== 'running' && !this.held) throw new Error('Audio output is blocked: the sound could not start.');
    }
    if (audio instanceof PcmStream) return this.playStream(audio, ctx, analyser);
    const buffer = audio;
    return new Promise((resolve) => {
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(analyser);
      this.source = src;
      src.onended = () => {
        if (this.source === src) this.source = null;
        resolve();
      };
      this.setLevelSource(() => rms(analyser));
      src.start();
    });
  }

  /**
   * Plays speech while it arrives: each block received is scheduled right after the previous
   * one (a small margin at the start and after a network pause, so it never crackles).
   * Resolves when the last block has been heard, or at once when stopped.
   */
  private async playStream(stream: PcmStream, ctx: AudioContext, analyser: AnalyserNode): Promise<void> {
    const token = this.playToken;
    this.setLevelSource(() => rms(analyser));
    let at = 0;
    let last: AudioBufferSourceNode | null = null;
    for (;;) {
      await new Promise<void>((resolve) => {
        this.stopWaiters.add(resolve);
        void stream.ready().then(() => {
          this.stopWaiters.delete(resolve);
          resolve();
        });
      });
      if (token !== this.playToken) return; // stopped
      const samples = stream.take();
      if (!samples) {
        if (stream.done) break;
        continue;
      }
      const buffer = ctx.createBuffer(1, samples.length, stream.sampleRate);
      buffer.copyToChannel(samples, 0);
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(analyser);
      if (at < ctx.currentTime + 0.02) at = ctx.currentTime + 0.06;
      src.start(at);
      at += buffer.duration;
      this.streamSources.add(src);
      src.onended = () => this.streamSources.delete(src);
      last = src;
    }
    if (!last) {
      if (stream.error) throw stream.error;
      return;
    }
    const final = last;
    await new Promise<void>((resolve) => {
      // Already over, stopped meanwhile, or still to come.
      if (!this.streamSources.has(final)) return resolve();
      final.addEventListener('ended', () => resolve(), { once: true });
    });
  }

  private setLevelSource(read: (() => number) | null) {
    cancelAnimationFrame(this.raf);
    if (!read) {
      this.cb.onLevel(0);
      return;
    }
    const tick = () => {
      this.cb.onLevel(read());
      this.raf = requestAnimationFrame(tick);
    };
    tick();
  }
}
