/// <reference lib="webworker" />
import { env, pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';
// The onnxruntime binary of transformers' own onnxruntime-web version (alias: vite.config.ts).
import ortWasmUrl from '@whisper-ort/ort-wasm-simd-threaded.asyncify.wasm?url';

/**
 * Sentence embeddings for the memory's search by meaning (lib/semantic.ts), on this device:
 * multilingual E5 small (quantized, ~120 MB, downloaded once from Hugging Face then cached). A
 * text becomes 384 numbers; texts that mean the same thing — in any language — get close ones.
 */

export type EmbedRequest = { id: number; texts: string[]; kind: 'query' | 'passage' };
export type EmbedResponse = { id: number; vectors: Float32Array[] } | { id: number; error: string } | { id: -1; progress: number };

// (Not exported: importing values from this file would run the worker in the page. Keep in sync
// with lib/semantic.ts.)
const EMBED_MODEL = 'Xenova/multilingual-e5-small';
const EMBED_DIMS = 384;

env.allowLocalModels = false;
env.backends.onnx.wasm!.wasmPaths = { wasm: new URL(ortWasmUrl, self.location.href).href };

let extractor: Promise<FeatureExtractionPipeline> | null = null;

function load() {
  extractor ??= (async () => {
    const files = new Map<string, { loaded: number; total: number }>();
    return (await pipeline('feature-extraction', EMBED_MODEL, {
      dtype: 'q8',
      device: 'wasm',
      progress_callback: (p: { status: string; file?: string; loaded?: number; total?: number }) => {
        if (p.status !== 'progress' || !p.file || !p.total) return;
        files.set(p.file, { loaded: p.loaded ?? 0, total: p.total });
        let loaded = 0;
        let total = 0;
        files.forEach((f) => ((loaded += f.loaded), (total += f.total)));
        self.postMessage({ id: -1, progress: Math.round((loaded / total) * 100) } satisfies EmbedResponse);
      },
    })) as FeatureExtractionPipeline;
  })();
  extractor.catch(() => {
    extractor = null; // a failed download can be retried
  });
  return extractor;
}

self.onmessage = async (e: MessageEvent<EmbedRequest>) => {
  const { id, texts, kind } = e.data;
  try {
    const run = await load();
    // E5 was trained with these prefixes: questions and stored texts are embedded differently.
    const output = await run(
      texts.map((t) => `${kind}: ${t}`),
      { pooling: 'mean', normalize: true },
    );
    const data = output.data as Float32Array;
    const vectors = texts.map((_, i) => data.slice(i * EMBED_DIMS, (i + 1) * EMBED_DIMS));
    self.postMessage({ id, vectors } satisfies EmbedResponse, vectors.map((v) => v.buffer));
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) } satisfies EmbedResponse);
  }
};
