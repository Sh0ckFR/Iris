import { MicVAD } from '@ricky0123/vad-web';
import type { AsrRequest, AsrResponse } from './localAsr.worker';
import vadOrtWasm from '@vad-ort/ort-wasm-simd-threaded.wasm?url';
import { IS_MOBILE } from '../../lib/platform';

/**
 * Always-on listening, on this computer only: a voice activity detector (Silero VAD) cuts the
 * microphone audio into sentences and local Whisper transcribes them. Nothing is sent anywhere
 * (and no tokens are spent) until a sentence is meant for Iris — which the caller decides.
 */

export type LocalWakeStatus = 'off' | 'loading' | 'listening' | 'paused' | 'error';

/** Which Whisper transcribes, and on what: the GPU (WebGPU) or the CPU (WebAssembly). */
export interface SpeechEngine {
  device: 'webgpu' | 'wasm';
  model: string;
}

const MIC_CONSTRAINTS: MediaStreamConstraints = {
  audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
};

export interface LocalWakeCallbacks {
  /** `detail`: download progress ("42 %") or the error message. */
  onStatus: (status: LocalWakeStatus, detail?: string) => void;
  /**
   * A sentence heard and transcribed locally, with its audif (16 kHz) and when it started
   * (ms): the caller decides whether it was meant for Iris (name, follow-up…).
   */
  onSpeech: (text: string, audio: Float32Array, startedAt: number) => void;
  /** Language to transcribe in ('fr', 'en'), or null to let Whisper detect it. */
  language: () => string | null;
  /** Microphone loudness (0..1) on standby, for the eye. */
  onLevel?: (level: number) => void;
  /** Real speech has started (past the first 150 ms): Iris pauses if she was talking. */
  onSpeechStart?: () => void;
  /** What had started was not a sentence after all (too short, or nothing transcribed). */
  onSpeechDropped?: () => void;
  /** The speech recognition is ready: which model, on the GPU or the CPU. */
  onEngine?: (engine: SpeechEngine) => void;
}

/** Sentences waiting for Whisper are dropped beyond this (it can't keep up: people are chatting). */
const MAX_QUEUE = 2;

export class LocalWakeListener {
  private vad: MicVAD | null = null;
  private worker: Worker | null = null;
  private paused = false;
  private stopped = false;
  private ready = false;
  private seq = 0;
  private pending = new Map<number, (text: string | null) => void>();
  private queued = 0;
  private speechStartedAt = 0;
  /** The microphone stream and audio context in use, watched for the OS taking them away. */
  private stream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private recovering = false;

  constructor(private readonly cb: LocalWakeCallbacks) {}

  /**
   * Back in the foreground: phones (and laptops waking from sleep) may have taken the
   * microphone away or suspended the audio while Iris was hidden. Reopen what was lost.
   */
  private readonly onVisibility = () => {
    if (document.visibilityState === 'visible') void this.recover();
  };

  private async recover() {
    if (!this.ready || this.stopped || this.paused || !this.vad || this.recovering) return;
    this.recovering = true;
    try {
      if (this.audioContext && this.audioContext.state !== 'running' && this.audioContext.state !== 'closed') {
        await this.audioContext.resume().catch(() => {});
      }
      const track = this.stream?.getAudioTracks()[0];
      if (!track || track.readyState === 'ended' || track.muted) {
        console.warn('[iris:wake] the microphone was lost while Iris was in the background: reopening it');
        await this.vad.pause().catch(() => {});
        await this.vad.start();
        this.cb.onStatus('listening');
      }
    } catch (error) {
      this.cb.onStatus('error', error instanceof Error ? error.message : String(error));
    } finally {
      this.recovering = false;
    }
  }

  async start() {
    this.cb.onStatus('loading');
    try {
      this.worker = new Worker(new URL('./localAsr.worker.ts', import.meta.url), { type: 'module' });
      const modelReady = new Promise<void>((resolve, reject) => {
        this.worker!.onmessage = (e: MessageEvent<AsrResponse>) => {
          const msg = e.data;
          if (msg.type === 'progress') this.cb.onStatus('loading', `${msg.percent} %`);
          else if (msg.type === 'ready') {
            // console.warn: forwarded to the dev log, like the other voice diagnostics.
            console.warn(`[iris:wake] local Whisper ready (${msg.model}, ${msg.device})`);
            this.cb.onEngine?.({ device: msg.device, model: msg.model });
            resolve();
          } else if (msg.type === 'result') this.settle(msg.id, msg.text);
          else if (msg.type === 'error') {
            if (msg.id === undefined) reject(new Error(msg.message));
            else {
              console.warn('[iris:wake] transcription failed', msg.message);
              this.settle(msg.id, null);
            }
          }
        };
      });
      modelReady.catch(() => {}); // awaited below; never an unhandled rejection meanwhile
      this.send({ type: 'load', mobile: IS_MOBILE });

      // Ours rather than vad-web's, so it can be resumed after the app was in the background.
      this.audioContext = new AudioContext();
      const openMic = async () => {
        this.stream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
        return this.stream;
      };
      this.vad = await MicVAD.new({
        audioContext: this.audioContext,
        resumeStream: openMic,
        model: 'v5',
        baseAssetPath: '/local-ai/vad/',
        // onnxruntime of vad-web's own version, shipped with the app: its JS glue (served by
        // vite.config.ts) and its binary. Typed as a folder path, but assigned to onnxruntime's
        // wasmPaths, which also accepts the files themselves.
        onnxWASMBasePath: {
          mjs: new URL('/local-ai/vad/ort-wasm-simd-threaded.mjs', location.href).href,
          wasm: new URL(vadOrtWasm, location.href).href,
        } as unknown as string,
        startOnLoad: false,
        getStream: async () => {
          const stream = await openMic();
          console.warn(`[iris:wake] microphone: ${stream.getAudioTracks()[0]?.label || 'unknown'}`);
          return stream;
        },
        // Keep the start of "Iris", and answer quickly once the sentence is over. A lone,
        // quickly said "Iris?" has little more than 150 ms of clear speech: keep it.
        preSpeechPadMs: 400,
        redemptionMs: 700,
        minSpeechMs: 150,
        onFrameProcessed: (_probabilities, frame) => {
          let sum = 0;
          for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
          this.cb.onLevel?.(Math.min(1, Math.sqrt(sum / frame.length) * 4)); // same scale as audio.ts rms()
        },
        onSpeechStart: () => {
          this.speechStartedAt = Date.now();
          console.warn('[iris:wake] speech started');
        },
        onSpeechRealStart: () => this.cb.onSpeechStart?.(),
        onVADMisfire: () => {
          console.warn('[iris:wake] speech too short, ignored');
          this.cb.onSpeechDropped?.();
        },
        onSpeechEnd: (audio) => void this.handleSpeech(audio, this.speechStartedAt),
      });
      // Stopped while loading (e.g. React re-mounting the effect): don't leave a detector behind.
      if (this.stopped) {
        await this.vad.destroy().catch(() => {});
        this.vad = null;
        return;
      }
      await modelReady;
      if (this.stopped) return;
      this.ready = true;
      document.addEventListener('visibilitychange', this.onVisibility);
      await this.apply();
    } catch (error) {
      if (this.stopped) return;
      const message = error instanceof Error ? error.message : String(error);
      console.warn('[iris:wake] local wake word unavailable', error);
      this.cb.onStatus('error', message);
    }
  }

  /** The cloud voice session is open: stop analysing (it listens itself). */
  pause() {
    this.paused = true;
    void this.apply();
  }

  /** Back to standby. */
  resume() {
    this.paused = false;
    void this.apply();
  }

  async stop() {
    this.stopped = true;
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.pending.forEach((resolve) => resolve(null));
    this.pending.clear();
    this.worker?.terminate();
    this.worker = null;
    await this.vad?.destroy().catch(() => {});
    this.vad = null;
    this.stream = null;
    await this.audioContext?.close().catch(() => {});
    this.audioContext = null;
  }

  private async apply() {
    if (!this.ready || this.stopped || !this.vad) return;
    try {
      if (this.paused) {
        await this.vad.pause();
        this.cb.onLevel?.(0);
        this.cb.onStatus('paused');
      } else {
        await this.vad.start();
        this.cb.onStatus('listening');
      }
    } catch (error) {
      this.cb.onStatus('error', error instanceof Error ? error.message : String(error));
    }
  }

  private send(message: AsrRequest, transfer: Transferable[] = []) {
    this.worker?.postMessage(message, transfer);
  }

  private settle(id: number, text: string | null) {
    this.pending.get(id)?.(text);
    this.pending.delete(id);
  }

  /** Transcribes a stretch of audio again (the known voice's part of a sentence). */
  retranscribe(audio: Float32Array): Promise<string | null> {
    return this.transcribe(audio.slice());
  }

  private transcribe(audio: Float32Array): Promise<string | null> {
    const id = ++this.seq;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.send({ type: 'transcribe', id, audio, language: this.cb.language() }, [audio.buffer]);
    });
  }

  private async handleSpeech(audio: Float32Array, startedAt: number) {
    const seconds = (audio.length / 16_000).toFixed(1);
    if (this.paused || this.stopped || this.queued >= MAX_QUEUE) {
      this.cb.onSpeechDropped?.();
      console.warn(`[iris:wake] speech (${seconds} s) skipped: ${this.paused ? 'session open' : this.stopped ? 'stopped' : 'busy'}`);
      return;
    }
    console.warn(`[iris:wake] speech detected (${seconds} s), transcribing…`);
    this.queued++;
    try {
      // A copy goes to the worker (transferred, so detached here): the audio itself is kept for
      // the cloud session to hear.
      const text = await this.transcribe(audio.slice());
      // The session may have been opened (Space key) while Whisper was working.
      if (!text || this.paused || this.stopped) {
        this.cb.onSpeechDropped?.();
        return;
      }
      this.cb.onSpeech(text, audio, startedAt);
    } finally {
      this.queued--;
    }
  }
}
