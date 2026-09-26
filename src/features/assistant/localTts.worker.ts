/// <reference lib="webworker" />
import { TtsSession } from '@mintplex-labs/piper-tts-web';
import piperOrtWasm from '@piper-ort/ort-wasm-simd-threaded.wasm?url';

/**
 * Local text-to-speech (Piper, on this computer): free and offline once a voice is downloaded
 * (~60 MB each, kept in the app's private storage). Runs in a worker so synthesizing a sentence
 * never stalls the HUD.
 */

export interface TtsRequest {
  id: number;
  text: string;
  voiceId: string;
}

export type TtsResponse =
  | { id: number; wav: ArrayBuffer }
  | { id: number; error: string }
  | { id: number; progress: number }
  | { id: number; log: string };

const sessions = new Map<string, Promise<TtsSession>>();

function session(voiceId: string, id: number): Promise<TtsSession> {
  let s = sessions.get(voiceId);
  if (!s) {
    // The library keeps one session and hands it back for any voice, with the first voice's
    // model still loaded: forget it, so each voice (French, English) gets its own session.
    (TtsSession as unknown as { _instance?: unknown })._instance = undefined;
    s = TtsSession.create({
      voiceId: voiceId as ConstructorParameters<typeof TtsSession>[0]['voiceId'],
      // The phonemizer comes from Piper's defaults (CDN, cached); onnxruntime's binary ships with
      // the app (typed as a folder path, but assigned to onnxruntime's wasmPaths, which also
      // accepts the file itself).
      wasmPaths: {
        ...TtsSession.WASM_LOCATIONS,
        onnxWasm: { wasm: new URL(piperOrtWasm, self.location.href).href } as unknown as string,
      },
      progress: (p: { loaded: number; total: number }) => {
        if (p.total) self.postMessage({ id, progress: Math.round((p.loaded / p.total) * 100) } satisfies TtsResponse);
      },
      // The library's own steps, forwarded to the main window's log (diagnostics).
      logger: (message: string) => self.postMessage({ id, log: message } satisfies TtsResponse),
    });
    s.catch(() => sessions.delete(voiceId)); // a failed download can be retried
    sessions.set(voiceId, s);
  }
  return s;
}

self.onmessage = async (e: MessageEvent<TtsRequest>) => {
  const { id, text, voiceId } = e.data;
  try {
    const wav = await (await (await session(voiceId, id)).predict(text)).arrayBuffer();
    self.postMessage({ id, wav } satisfies TtsResponse, [wav]);
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) } satisfies TtsResponse);
  }
};

// An error thrown outside a request (the phonemizer reports its errors by throwing from a
// callback) would otherwise leave the sentence waiting forever: report it for every pending one.
self.addEventListener('error', (e) => self.postMessage({ id: -1, error: e.message } satisfies TtsResponse));
self.addEventListener('unhandledrejection', (e) => self.postMessage({ id: -1, error: String(e.reason) } satisfies TtsResponse));
