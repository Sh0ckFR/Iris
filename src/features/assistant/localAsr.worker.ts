/// <reference lib="webworker" />
import {
  AutoModel,
  AutoProcessor,
  AutoTokenizer,
  env,
  WhisperForConditionalGeneration,
  type PreTrainedModel,
  type PreTrainedTokenizer,
  type Processor,
  type Tensor,
} from '@huggingface/transformers';
// The onnxruntime binary of transformers' own onnxruntime-web version (alias: vite.config.ts).
import ortWasmUrl from '@whisper-ort/ort-wasm-simd-threaded.asyncify.wasm?url';

/**
 * Local speech recognition (Whisper, on this computer) for the standby wake word: transcribes
 * the sentences the voice activity detector hands over, without sending audio anywhere.
 *
 * The model is downloaded from Hugging Face on first use, then served from the browser cache.
 * WebGPU when available ("small": accurate and fast on a GPU), otherwise WebAssembly with the
 * lighter "base" model (small would be too slow on a CPU). Phones and tablets with less than
 * 6 GB of memory (or that don't tell) take "base" even with WebGPU: small (≈ 390 MB) would strain
 * their webview; the others keep small, much better at names and accents.
 *
 * The same worker computes voiceprints (speaker embeddings, see lib/voiceprint.ts) when asked:
 * a separate, smaller model, loaded only if voice recognition is used.
 */

export type AsrRequest =
  /** `mobile`: a device that should take the lighter model (see above). */
  | { type: 'load'; mobile?: boolean }
  | { type: 'transcribe'; id: number; audio: Float32Array; language: string | null }
  | { type: 'embed'; id: number; audio: Float32Array };

export type AsrResponse =
  | { type: 'progress'; percent: number }
  | { type: 'ready'; device: 'webgpu' | 'wasm'; model: string }
  | { type: 'result'; id: number; text: string }
  | { type: 'embedding'; id: number; vector: number[] }
  | { type: 'error'; id?: number; message: string };

/**
 * Speaker verification model (ResNet34 trained on VoxCeleb, 25 MB): a 256-number voiceprint per
 * sentence. (WavLM x-vectors, tried first, scored different voices as alike.)
 */
const SPEAKER_MODEL = 'onnx-community/wespeaker-voxceleb-resnet34-LM';

let speaker: Promise<{ model: PreTrainedModel; processor: Processor }> | null = null;

function loadSpeaker() {
  speaker ??= (async () => {
    const [model, processor] = await Promise.all([
      AutoModel.from_pretrained(SPEAKER_MODEL, { dtype: 'fp32', device: 'wasm' }),
      AutoProcessor.from_pretrained(SPEAKER_MODEL),
    ]);
    return { model, processor };
  })();
  speaker.catch(() => {
    speaker = null; // a failed download can be retried
  });
  return speaker;
}

/** The voiceprint of a stretch of speech (16 kHz). */
async function embed(audio: Float32Array): Promise<number[]> {
  const { model, processor } = await loadSpeaker();
  const inputs = await processor(audio.length > MAX_SAMPLES ? audio.subarray(0, MAX_SAMPLES) : audio);
  const outputs = (await model(inputs)) as Record<string, Tensor>;
  const vector = outputs.embeddings ?? outputs.last_hidden_state ?? Object.values(outputs)[0];
  return Array.from(vector.data as Float32Array);
}

env.allowLocalModels = false;
// onnxruntime's WebAssembly binary ships with the app (Vite emits it) instead of coming from a CDN;
// its JS loader is already bundled with onnxruntime-web/webgpu, so only the .wasm is given.
env.backends.onnx.wasm!.wasmPaths = { wasm: new URL(ortWasmUrl, self.location.href).href };

/**
 * Unprompted, Whisper hears a short name like "Iris" as other words ("Irisse", "Hiris", "Y ris"…,
 * or "Irish" in English). A previous-text prompt using the name (what OpenAI's Whisper calls
 * `initial_prompt`) makes it spell it right.
 */
const PROMPTS: Record<string, string> = {
  fr: 'Iris, quelle heure est-il ? Merci, Iris.',
  en: 'Iris, what time is it? Thank you, Iris.',
};
const DEFAULT_PROMPT = 'Iris.';

/** A wake-up sentence is short; this also stops Whisper's repetition loops ("très très très…"). */
const MAX_NEW_TOKENS = 96;
/** Whisper's window: longer segments are cut (a request to Iris fits easily). */
const MAX_SAMPLES = 30 * 16_000;

interface Asr {
  model: WhisperForConditionalGeneration;
  processor: Processor;
  tokenizer: PreTrainedTokenizer;
}

const post = (message: AsrResponse) => self.postMessage(message);

let asr: Promise<Asr> | null = null;

/** The GPU adapter, if WebGPU works here. */
async function gpuAdapter(): Promise<{ features: { has(name: string): boolean } } | null> {
  try {
    const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<{ features: { has(name: string): boolean } } | null> } }).gpu;
    return (await gpu?.requestAdapter()) ?? null;
  } catch {
    return null;
  }
}

function load(mobile = false): Promise<Asr> {
  asr ??= (async () => {
    // Overall download progress across the model's files.
    const files = new Map<string, { loaded: number; total: number }>();
    const progress_callback = (p: { status: string; file?: string; loaded?: number; total?: number }) => {
      if (p.status !== 'progress' || !p.file || !p.total) return;
      files.set(p.file, { loaded: p.loaded ?? 0, total: p.total });
      let loaded = 0;
      let total = 0;
      files.forEach((f) => {
        loaded += f.loaded;
        total += f.total;
      });
      post({ type: 'progress', percent: Math.round((loaded / total) * 100) });
    };

    const open = async (name: string, options: Record<string, unknown>) => {
      const id = `onnx-community/${name}`;
      const [model, processor, tokenizer] = await Promise.all([
        WhisperForConditionalGeneration.from_pretrained(id, { ...options, progress_callback }),
        AutoProcessor.from_pretrained(id, { progress_callback }),
        AutoTokenizer.from_pretrained(id, { progress_callback }),
      ]);
      return { model: model as WhisperForConditionalGeneration, processor, tokenizer };
    };

    const adapter = await gpuAdapter();
    if (adapter) {
      try {
        const encoder = adapter.features.has('shader-f16') ? 'fp16' : 'fp32';
        const name = mobile ? 'whisper-base' : 'whisper-small';
        const loaded = await open(name, { device: 'webgpu', dtype: { encoder_model: encoder, decoder_model_merged: 'q4' } });
        post({ type: 'ready', device: 'webgpu', model: `${name} (encoder ${encoder})` });
        return loaded;
      } catch (error) {
        console.warn('[iris:wake] WebGPU unavailable for Whisper, falling back to WebAssembly', error);
      }
    }
    const loaded = await open('whisper-base', { device: 'wasm', dtype: 'q8' });
    post({ type: 'ready', device: 'wasm', model: 'whisper-base' });
    return loaded;
  })();
  asr.catch(() => {
    asr = null; // a failed download can be retried
  });
  return asr;
}

/** One special token's id ("<|fr|>"…), or null if this model doesn't have it. */
function tokenId(tokenizer: PreTrainedTokenizer, token: string): number | null {
  const ids = tokenizer.encode(token, { add_special_tokens: false });
  return ids.length === 1 ? ids[0] : null;
}

async function transcribe({ model, processor, tokenizer }: Asr, audio: Float32Array, language: string | null): Promise<string> {
  const { input_features } = await processor(audio.length > MAX_SAMPLES ? audio.subarray(0, MAX_SAMPLES) : audio);

  // <|startofprev|> prompt <|startoftranscript|> <|lang|> <|transcribe|> <|notimestamps|>
  const lang = (language && tokenId(tokenizer, `<|${language}|>`)) ?? tokenId(tokenizer, '<|fr|>');
  const prompt = tokenizer.encode(` ${PROMPTS[language ?? ''] ?? DEFAULT_PROMPT}`, { add_special_tokens: false });
  const decoderInput = [
    tokenId(tokenizer, '<|startofprev|>'),
    ...prompt,
    tokenId(tokenizer, '<|startoftranscript|>'),
    lang,
    tokenId(tokenizer, '<|transcribe|>'),
    tokenId(tokenizer, '<|notimestamps|>'),
  ];
  if (decoderInput.some((id) => id === null)) throw new Error('Unexpected Whisper tokenizer (missing special tokens).');

  const output = (await model.generate({
    inputs: input_features,
    decoder_input_ids: decoderInput as number[],
    max_new_tokens: MAX_NEW_TOKENS,
  } as Parameters<typeof model.generate>[0])) as Tensor;

  // The output starts with the prompt: only what follows is the transcript (otherwise every
  // sentence would "contain" Iris).
  const tokens = (output.tolist() as (number | bigint)[][])[0].map(Number).slice(decoderInput.length);
  return tokenizer.decode(tokens, { skip_special_tokens: true }).trim();
}

self.onmessage = async (e: MessageEvent<AsrRequest>) => {
  const msg = e.data;
  if (msg.type === 'load') {
    load(msg.mobile).catch((error) => post({ type: 'error', message: error instanceof Error ? error.message : String(error) }));
    return;
  }
  try {
    if (msg.type === 'embed') {
      post({ type: 'embedding', id: msg.id, vector: await embed(msg.audio) });
      return;
    }
    post({ type: 'result', id: msg.id, text: await transcribe(await load(), msg.audio, msg.language) });
  } catch (error) {
    post({ type: 'error', id: msg.id, message: error instanceof Error ? error.message : String(error) });
  }
};
