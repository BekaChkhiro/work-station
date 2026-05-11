// T13.1: register MonacoEnvironment so monaco-editor can spin up its web
// workers under Tauri's WebView. Vite resolves the `?worker` import to a
// bundled worker chunk, which means we don't depend on a CDN, AMD loader,
// or `monaco-editor-webpack-plugin` (none of which play nicely with the
// `file://` origin Tauri serves the production build from).
//
// Only the base editor worker is wired here — language-specific workers
// (TS, CSS, HTML, JSON) are deferred to T13.7 when language wiring lands.
// Until then, any unknown label falls through to the editor worker, which
// is what monaco does internally when a language worker is unavailable.

import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";

interface MonacoEnvironmentLike {
  getWorker(workerId: string, label: string): Worker;
}

interface MonacoEnvironmentHost {
  MonacoEnvironment?: MonacoEnvironmentLike;
}

let configured = false;

/** Idempotent — safe to call from every Monaco mount. The first call wins;
 *  later calls are no-ops so multiple editor instances share one config. */
export function ensureMonacoEnvironment(): void {
  if (configured) return;
  configured = true;
  const host = globalThis as unknown as MonacoEnvironmentHost;
  host.MonacoEnvironment = {
    getWorker(): Worker {
      return new EditorWorker();
    },
  };
}
