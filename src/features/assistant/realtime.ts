import { asSchema, type ToolSet } from 'ai';
import { rms } from './audio';
import { languageHint } from './language';
import { isAddressedToIris } from './wakeWord';
import { recordRealtimeUsage, type RealtimeUsage } from '../../lib/usage';

/**
 * Voice conversations with OpenAI Realtime (speech-to-speech) over WebRTC.
 *
 * The browser streams the microphone straight to OpenAI and plays the model's voice; a data
 * channel ("oai-events") carries transcripts, tool calls and control events. The API key never
 * leaves the app: it only mints a short-lived client secret, which opens the WebRTC call.
 * Docs: developers.openai.com/api/docs/guides/realtime-webrtc
 */

export interface RealtimeHistoryItem {
  role: 'user' | 'assistant';
  content: string;
}

export interface RealtimeOptions {
  apiKey: string;
  model: string;
  voice: string;
  instructions: string;
  tools: ToolSet;
  /** ISO-639-1 hint for the user's speech ("fr", "en"); omit for automatic detection. */
  language?: string;
  /** Language the user is currently speaking, if known (see setUserLanguage). */
  userLanguage?: string | null;
  /** Vocabulary hint for the transcription (names, brands…). */
  transcriptionPrompt?: string;
  /** Recent text conversation, so the voice session has the context. */
  history: RealtimeHistoryItem[];
  /**
   * Only answer sentences that start with "Iris": the model no longer replies (or stops
   * talking) whenever it hears speech; each transcript is checked first.
   */
  wakeWord?: boolean;
  /**
   * Hands-free wake-up: the sentence that woke Iris on local standby (16 kHz samples). It is
   * replayed into the call first, so the model hears the real voice rather than the rough local
   * transcript; `text` (that transcript) is only sent if the replay isn't picked up.
   */
  prelude?: { audio: Float32Array; text: string };
}

export interface RealtimeCallbacks {
  /** The user started talking (the model stops speaking by itself: barge-in). */
  onUserSpeechStart: () => void;
  /** The user stopped talking; `itemId` identifies the upcoming transcript. */
  onUserSpeechEnd?: (itemId: string) => void;
  /** What the user said (with the wake word on: only sentences addressed to Iris). */
  onUserTranscript: (itemId: string, text: string) => void;
  /** Wake word on: speech that wasn't addressed to Iris, dropped from the conversation. */
  onIgnoredSpeech?: (itemId: string, text: string) => void;
  onAssistantDelta: (responseId: string, delta: string) => void;
  onAssistantDone: (responseId: string, text: string) => void;
  /** Model audio started / stopped playing. */
  onSpeaking: (speaking: boolean) => void;
  /** Executes a tool the model asked for; resolves with its result (sent back to the model). */
  runTool: (name: string, args: unknown, callId: string, responseId: string) => Promise<unknown>;
  onLevel: (level: number) => void;
  onError: (error: Error) => void;
  /** The session ended (closed by us or by the connection). */
  onClosed: () => void;
}

const CLIENT_SECRETS_URL = 'https://api.openai.com/v1/realtime/client_secrets';
const CALLS_URL = 'https://api.openai.com/v1/realtime/calls';
const TRANSCRIPTION_MODEL = 'gpt-4o-transcribe';
/** With the wake word: after Iris stops talking, the user can answer without her name for this long. */
const FOLLOW_UP_MS = 8_000;

/** Iris tools (AI SDK format) → Realtime function definitions. */
export async function toRealtimeTools(tools: ToolSet) {
  return Promise.all(
    Object.entries(tools).map(async ([name, t]) => {
      const schema = { ...((await asSchema(t.inputSchema).jsonSchema) as Record<string, unknown>) };
      delete schema.$schema;
      return { type: 'function' as const, name, description: t.description ?? '', parameters: schema };
    }),
  );
}

async function failure(response: Response, what: string): Promise<Error> {
  const body = await response.text().catch(() => '');
  let message = body;
  try {
    message = (JSON.parse(body) as { error?: { message?: string } }).error?.message ?? body;
  } catch {
    // keep raw body
  }
  return new Error(`${what} (HTTP ${response.status}): ${message.slice(0, 200)}`);
}

type ServerEvent = {
  type: string;
  item_id?: string;
  response_id?: string;
  delta?: string;
  transcript?: string;
  error?: { message?: string; code?: string };
  response?: {
    id: string;
    status?: string;
    status_details?: { error?: { message?: string } };
    output?: { type: string; name?: string; call_id?: string; arguments?: string }[];
    usage?: RealtimeUsage;
  };
};

export class RealtimeSession {
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private mic: MediaStream | null = null;
  private player: HTMLAudioElement | null = null;
  private ctx: AudioContext | null = null;
  private micAnalyser: AnalyserNode | null = null;
  private outAnalyser: AnalyserNode | null = null;
  private raf = 0;
  private speaking = false;
  /** A response is being generated (between response.created and response.done). */
  private responding = false;
  private wakeWord = false;
  /** Until when a new sentence counts as a follow-up (0 while Iris speaks). */
  private followUpUntil = 0;
  /** Per user sentence (item id): did it start inside the follow-up window? */
  private followUps = new Map<string, boolean>();
  /** With a prelude: the microphone goes through Web Audio so the prelude can be played into the call. */
  private outgoing: MediaStreamAudioDestinationNode | null = null;
  private preludeHeard = false;
  private preludeTimer = 0;
  private closed = false;
  private handledCalls = new Set<string>();
  private baseInstructions = '';
  private userLanguage: string | null = null;

  constructor(private readonly cb: RealtimeCallbacks) {}

  get active() {
    return !this.closed && this.dc?.readyState === 'open';
  }

  async start(o: RealtimeOptions): Promise<void> {
    const t0 = performance.now();
    // Connection diagnostics end up in the dev log (console.warn is forwarded there).
    const step = (what: string) => console.warn(`[iris:realtime] ${what} (+${Math.round(performance.now() - t0)} ms)`);

    this.mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    step(`microphone ready: ${this.mic.getAudioTracks()[0]?.label || 'unknown'}`);
    if (this.closed) return this.close();

    // 1. Short-lived client secret for this call. OpenAI allows these calls from any origin
    //    (CORS "*"), so the webview's own fetch is used — the officially documented browser path.
    const secretResponse = await fetch(CLIENT_SECRETS_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${o.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: { type: 'realtime', model: o.model, audio: { output: { voice: o.voice } } } }),
      signal: AbortSignal.timeout(15_000),
    });
    step(`client secret: HTTP ${secretResponse.status}`);
    if (!secretResponse.ok) throw await failure(secretResponse, 'OpenAI Realtime refused to open a session');
    const secret = ((await secretResponse.json()) as { value?: string }).value;
    if (!secret) throw new Error('OpenAI Realtime returned no client secret.');
    if (this.closed) return this.close();

    // 2. WebRTC: microphone out, model voice in, events on the data channel.
    const pc = new RTCPeerConnection();
    this.pc = pc;
    this.player = new Audio();
    this.player.autoplay = true;
    pc.ontrack = (e) => {
      step('voice track received');
      const [stream] = e.streams;
      if (!this.player || !stream) return;
      this.player.srcObject = stream; // Chromium only feeds the analyser if the stream is also played
      // Don't rely on autoplay inside the webview: start playback explicitly.
      this.player.play().then(
        () => step('voice playback started'),
        (error) => step(`voice playback BLOCKED: ${error instanceof Error ? error.message : String(error)}`),
      );
      this.outAnalyser = this.analyse(stream);
    };
    pc.oniceconnectionstatechange = () => step(`ICE ${pc.iceConnectionState}`);
    pc.onconnectionstatechange = () => {
      step(`connection ${pc.connectionState}`);
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState) && !this.closed) {
        if (pc.connectionState !== 'closed') this.cb.onError(new Error('The voice connection was lost.'));
        this.close();
      }
    };
    if (o.prelude) {
      this.ctx ??= new AudioContext();
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      const outgoing = this.ctx.createMediaStreamDestination();
      this.ctx.createMediaStreamSource(this.mic).connect(outgoing);
      this.outgoing = outgoing;
      pc.addTrack(outgoing.stream.getAudioTracks()[0], outgoing.stream);
    } else {
      const [track] = this.mic.getAudioTracks();
      pc.addTrack(track, this.mic);
    }
    this.micAnalyser = this.analyse(this.mic);

    const dc = pc.createDataChannel('oai-events');
    this.dc = dc;
    dc.onmessage = (e) => {
      try {
        void this.handle(JSON.parse(e.data) as ServerEvent);
      } catch (error) {
        console.warn('[iris] realtime event', error);
      }
    };
    let openTimer = 0;
    const opened = new Promise<void>((resolve, reject) => {
      dc.onopen = () => {
        window.clearTimeout(openTimer);
        resolve();
      };
      openTimer = window.setTimeout(
        () =>
          reject(
            new Error(
              `The voice connection did not open (network state: ICE ${pc.iceConnectionState}, connection ${pc.connectionState}). A firewall or VPN may be blocking WebRTC.`,
            ),
          ),
        20_000,
      );
    });
    opened.catch(() => {}); // awaited below; never an unhandled rejection if an earlier step throws

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      step('offer created');
      const answer = await fetch(CALLS_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/sdp' },
        body: offer.sdp ?? '',
        signal: AbortSignal.timeout(15_000),
      });
      step(`call answer: HTTP ${answer.status}`);
      if (!answer.ok) throw await failure(answer, 'OpenAI Realtime refused the call');
      await pc.setRemoteDescription({ type: 'answer', sdp: await answer.text() });
      step('remote description set, waiting for the data channel');
      await opened;
      step('data channel open');
    } catch (error) {
      window.clearTimeout(openTimer);
      step(`failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
    if (this.closed) return this.close();

    // 3. Persona, tools, transcription and turn detection.
    this.baseInstructions = o.instructions;
    this.userLanguage = o.userLanguage ?? null;
    this.wakeWord = !!o.wakeWord;
    this.send({
      type: 'session.update',
      session: {
        type: 'realtime',
        instructions: this.instructions(),
        tools: await toRealtimeTools(o.tools),
        tool_choice: 'auto',
        audio: {
          input: {
            transcription: {
              model: TRANSCRIPTION_MODEL,
              ...(o.language ? { language: o.language } : {}),
              ...(o.transcriptionPrompt ? { prompt: o.transcriptionPrompt } : {}),
            },
            // Semantic VAD waits for the end of a thought rather than any pause. With the wake
            // word, we decide ourselves whether to answer (or interrupt) once the words are known.
            turn_detection: { type: 'semantic_vad', ...(this.wakeWord ? { create_response: false, interrupt_response: false } : {}) },
          },
          output: { voice: o.voice },
        },
      },
    });

    // 4. Carry over the recent text conversation.
    for (const m of o.history.slice(-12)) {
      this.send({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: m.role,
          content: [{ type: m.role === 'user' ? 'input_text' : 'output_text', text: m.content }],
        },
      });
    }

    if (o.prelude) this.playPrelude(o.prelude);
    this.startMeter();
  }

  /** Plays the wake-up sentence into the call, as if the user had just said it. */
  private playPrelude({ audio, text }: { audio: Float32Array; text: string }) {
    if (!this.ctx || !this.outgoing) return;
    const buffer = this.ctx.createBuffer(1, audio.length, 16_000);
    buffer.copyToChannel(audio as Float32Array<ArrayBuffer>, 0);
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.outgoing);
    const ms = buffer.duration * 1000;
    // It was addressed to Iris (checked locally): answer it even if the cloud transcript
    // misses the name.
    this.followUpUntil = Date.now() + ms + 1500;
    source.start();
    this.preludeTimer = window.setTimeout(() => {
      if (this.preludeHeard || this.closed) return;
      console.warn('[iris:realtime] wake-up audio not picked up; sending the local transcript');
      this.cb.onUserTranscript('prelude', text);
      this.sendText(text);
    }, ms + 2500);
  }

  private instructions(): string {
    const hint = languageHint(this.userLanguage);
    return hint ? `${this.baseInstructions}\n${hint}` : this.baseInstructions;
  }

  /**
   * The user's language, detected from their transcripts: re-sent in the instructions when it
   * changes, so replies (especially the ones after a tool call) stay in that language.
   */
  setUserLanguage(code: string | null) {
    if (!code || code === this.userLanguage) return;
    this.userLanguage = code;
    if (this.active) this.send({ type: 'session.update', session: { type: 'realtime', instructions: this.instructions() } });
  }

  /** A typed message during a voice session: answered by voice. */
  sendText(text: string) {
    this.send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
    this.send({ type: 'response.create' });
  }

  /**
   * Mutes / unmutes the microphone without ending the session: Iris keeps talking and working,
   * she just stops hearing you (a disabled track sends silence, so no new turn starts).
   */
  setMicEnabled(enabled: boolean) {
    this.mic?.getAudioTracks().forEach((t) => (t.enabled = enabled));
    if (!enabled) this.send({ type: 'input_audio_buffer.clear' }); // drop half-heard audio
  }

  /** Stops the current answer (voice and generation) without ending the session. */
  interrupt() {
    this.send({ type: 'response.cancel' });
    this.send({ type: 'output_audio_buffer.clear' });
  }

  /** Idempotent: always releases whatever exists (the mic may arrive after an early close). */
  close() {
    const first = !this.closed;
    this.closed = true;
    cancelAnimationFrame(this.raf);
    window.clearTimeout(this.preludeTimer);
    this.outgoing?.stream.getTracks().forEach((t) => t.stop());
    this.outgoing = null;
    this.cb.onLevel(0);
    try {
      this.dc?.close();
    } catch {
      // ignore
    }
    this.pc?.close();
    this.pc = null;
    this.dc = null;
    this.mic?.getTracks().forEach((t) => t.stop());
    this.mic = null;
    if (this.player) this.player.srcObject = null;
    this.player = null;
    void this.ctx?.close();
    this.ctx = null;
    this.setSpeaking(false);
    if (first) this.cb.onClosed();
  }

  private send(event: Record<string, unknown>) {
    if (this.dc?.readyState === 'open') this.dc.send(JSON.stringify(event));
  }

  private setSpeaking(value: boolean) {
    if (this.speaking === value) return;
    this.speaking = value;
    // Follow-up window: right after Iris has spoken, the user may go on without her name.
    this.followUpUntil = value ? 0 : Date.now() + FOLLOW_UP_MS;
    this.cb.onSpeaking(value);
  }

  private async handle(ev: ServerEvent) {
    const type = ev.type;
    if (type === 'error' || (type === 'response.done' && ev.response?.status === 'failed')) {
      console.warn(`[iris:realtime] ${type}: ${ev.error?.message ?? ev.response?.status_details?.error?.message ?? ''}`);
    }
    // What the server hears (dev log): turns and their transcripts.
    if (type === 'input_audio_buffer.speech_started' || type === 'input_audio_buffer.speech_stopped') {
      console.warn(`[iris:realtime] ${type.slice('input_audio_buffer.'.length)}`);
    } else if (type.endsWith('input_audio_transcription.completed')) {
      console.warn(`[iris:realtime] heard: "${(ev.transcript ?? '').trim()}"`);
    } else if (type.endsWith('input_audio_transcription.failed')) {
      console.warn(`[iris:realtime] transcription FAILED: ${ev.error?.message ?? JSON.stringify(ev)}`);
    } else if (type === 'session.updated' || type === 'session.created') {
      console.warn(`[iris:realtime] ${type}`);
    }
    if (type === 'input_audio_buffer.speech_started') {
      // Decided when the sentence starts: its transcript arrives after Iris may have spoken again.
      this.followUps.set(ev.item_id ?? '', Date.now() <= this.followUpUntil);
      this.preludeHeard = true;
      // Without the wake word, speaking cuts Iris off (barge-in); with it, she keeps talking.
      if (!this.wakeWord) this.setSpeaking(false);
      this.cb.onUserSpeechStart();
    } else if (type === 'input_audio_buffer.speech_stopped') {
      this.cb.onUserSpeechEnd?.(ev.item_id ?? '');
    } else if (type.endsWith('input_audio_transcription.completed')) {
      this.handleTranscript(ev.item_id ?? '', (ev.transcript ?? '').trim());
    } else if (type === 'response.created') {
      this.responding = true;
    } else if (type === 'response.output_audio_transcript.delta' || type === 'response.output_text.delta') {
      this.cb.onAssistantDelta(ev.response_id ?? '', ev.delta ?? '');
    } else if (type === 'response.output_audio_transcript.done' || type === 'response.output_text.done') {
      this.cb.onAssistantDone(ev.response_id ?? '', (ev.transcript ?? '').trim());
    } else if (type === 'output_audio_buffer.started') {
      this.setSpeaking(true);
    } else if (type === 'output_audio_buffer.stopped' || type === 'output_audio_buffer.cleared') {
      this.setSpeaking(false);
    } else if (type === 'response.done') {
      this.responding = false;
      recordRealtimeUsage(ev.response?.usage);
      await this.handleResponseDone(ev);
    } else if (type === 'error') {
      const message = ev.error?.message ?? 'Unknown Realtime error';
      // Cancelling when nothing is playing is harmless.
      if (!/no active response|cancellation failed/i.test(message)) this.cb.onError(new Error(message));
    }
  }

  /**
   * With the wake word, the model answers only sentences addressed to Iris (or said just after
   * she spoke): those interrupt whatever she is saying and get a reply; the others are removed from
   * the conversation so they never influence later answers.
   */
  private handleTranscript(itemId: string, text: string) {
    const followUp = this.followUps.get(itemId) ?? false;
    this.followUps.delete(itemId);
    if (!this.wakeWord) {
      this.cb.onUserTranscript(itemId, text);
      return;
    }
    if (!text || !(followUp || isAddressedToIris(text))) {
      if (itemId) this.send({ type: 'conversation.item.delete', item_id: itemId });
      this.cb.onIgnoredSpeech?.(itemId, text);
      return;
    }
    if (this.responding || this.speaking) this.interrupt();
    this.cb.onUserTranscript(itemId, text);
    this.send({ type: 'response.create' });
  }

  /** Runs the function calls of a finished response, returns their results, asks for the follow-up. */
  private async handleResponseDone(ev: ServerEvent) {
    const response = ev.response;
    if (!response) return;
    if (response.status === 'failed') {
      this.cb.onError(new Error(response.status_details?.error?.message ?? 'The voice model failed to answer.'));
      return;
    }
    const calls = (response.output ?? []).filter((o) => o.type === 'function_call' && o.call_id && !this.handledCalls.has(o.call_id));
    if (calls.length === 0) return;
    calls.forEach((c) => this.handledCalls.add(c.call_id!));
    // Several requests in one breath ("weather in Paris and the markets") run in parallel.
    const outputs = await Promise.all(
      calls.map(async (call) => {
        try {
          const args = call.arguments ? JSON.parse(call.arguments) : {};
          return await this.cb.runTool(call.name ?? '', args, call.call_id!, response.id);
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error) };
        }
      }),
    );
    if (this.closed) return;
    calls.forEach((call, i) =>
      this.send({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(outputs[i] ?? null) },
      }),
    );
    this.send({ type: 'response.create' });
  }

  private analyse(stream: MediaStream): AnalyserNode {
    this.ctx ??= new AudioContext();
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 512;
    this.ctx.createMediaStreamSource(stream).connect(analyser); // analysis only, not to speakers
    return analyser;
  }

  private startMeter() {
    const tick = () => {
      const source = this.speaking ? this.outAnalyser : this.micAnalyser;
      this.cb.onLevel(source ? rms(source) : 0);
      this.raf = requestAnimationFrame(tick);
    };
    tick();
  }
}
