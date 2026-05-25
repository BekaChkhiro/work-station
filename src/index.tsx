/* @refresh reload */
import { render } from "solid-js/web";
import { emit } from "@tauri-apps/api/event";
import App from "./App";

render(() => <App />, document.getElementById("root") as HTMLElement);

// T10.2: signal "first paint" so the Rust side can tear down for `hyperfine`.
// Tauri events aren't queued, so a single emit races with the Rust
// `listen_any` registration and is silently dropped on some launches —
// poll until the process is killed. Gated to dev builds so production
// launches don't burn an IPC + JSON serialize 20x/sec forever (the
// backend `listen_any` only registers when WS_BENCH_EXIT=1, but the
// emit itself still crosses the webview→Rust boundary).
if (import.meta.env.DEV) {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const tick = (): void => {
        emit("bench:ready").catch(() => undefined);
      };
      tick();
      setInterval(tick, 50);
    });
  });
}
