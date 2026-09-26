import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
// @ts-expect-error type error without @types/node package
import process from "node:process";
// @ts-expect-error type error without @types/node package
import fs from "node:fs";
const host = process.env.TAURI_DEV_HOST;

/**
 * The onnxruntime-web a package actually uses: npm nests a private copy when versions differ,
 * and which one is nested changes when dependencies change. Each library needs the runtime
 * files of *its* version.
 */
function ortDirOf(pkg: string): { dir: string } {
  const nested = `node_modules/${pkg}/node_modules/onnxruntime-web`;
  return { dir: `${fs.existsSync(nested) ? nested : "node_modules/onnxruntime-web"}/dist` };
}
const VAD_ORT = ortDirOf("@ricky0123/vad-web");
const PIPER_ORT = ortDirOf("@mintplex-labs/piper-tts-web");
const WHISPER_ORT = ortDirOf("@huggingface/transformers");

/**
 * Files of the voice activity detector, served from the app itself rather than a CDN (vad-web
 * loads them by URL). vad-web is CommonJS, so it gets onnxruntime's non-bundled build, which
 * loads its JS glue (.mjs) by URL too. The onnxruntime binaries (.wasm) are imported by the code
 * with the aliases below, so Vite ships each version once.
 */
const LOCAL_AI_ASSETS: Record<string, string> = {
  "local-ai/vad/vad.worklet.bundle.min.js": "node_modules/@ricky0123/vad-web/dist/vad.worklet.bundle.min.js",
  "local-ai/vad/silero_vad_v5.onnx": "node_modules/@ricky0123/vad-web/dist/silero_vad_v5.onnx",
  "local-ai/vad/ort-wasm-simd-threaded.mjs": `${VAD_ORT.dir}/ort-wasm-simd-threaded.mjs`,
};

const MIME: Record<string, string> = { js: "text/javascript", mjs: "text/javascript", wasm: "application/wasm" };

function localAiAssets(): Plugin {
  return {
    name: "iris-local-ai-assets",
    // Dev: served before Vite's own middlewares (which would try to transform the .mjs files).
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const source = LOCAL_AI_ASSETS[(req.url ?? "").split("?")[0].replace(/^\//, "")];
        if (!source) return next();
        res.setHeader("Content-Type", MIME[source.split(".").pop() ?? ""] ?? "application/octet-stream");
        fs.createReadStream(source).pipe(res);
      });
    },
    // Build: copied into dist/ next to the app.
    generateBundle() {
      for (const [fileName, source] of Object.entries(LOCAL_AI_ASSETS)) {
        this.emitFile({ type: "asset", fileName, source: fs.readFileSync(source) });
      }
    },
  };
}

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react(), localAiAssets()],
  // The onnxruntime files of each library's own version (see ortDirOf), for `?url` imports.
  resolve: {
    alias: {
      "@vad-ort": `${process.cwd()}/${VAD_ORT.dir}`,
      "@piper-ort": `${process.cwd()}/${PIPER_ORT.dir}`,
      "@whisper-ort": `${process.cwd()}/${WHISPER_ORT.dir}`,
    },
  },
  // The Whisper worker loads onnxruntime dynamically: it must be an ES module worker.
  worker: { format: "es" as const },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
      // 4. On Windows, native change events for several quick saves of the same file can be
      //    coalesced, leaving the dev server on a stale version (seen twice here). Polling the
      //    small `src` tree is cheap and never misses a save.
      usePolling: process.platform === "win32",
      interval: 150,
    },
  },
}));
