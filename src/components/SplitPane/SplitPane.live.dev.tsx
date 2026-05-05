// Dev-only harness: SplitPane around two real PTY-backed Terminals so the
// T5.2 acceptance can be exercised manually:
//
//   • Drag the handle and confirm the panes only resize on release (the
//     ghost line follows the cursor; the terminals stay still).
//   • Watch DevTools console — `pty_resize` traces should appear on
//     pointerup, not on every move event.
//   • Releasing near the middle should snap to a perfect 50/50.
//   • Each terminal keeps its scrollback after a drag (no remount).
//
// Reachable via `?wsdebug=splitpane` in dev builds.

import { Match, Show, Switch, createSignal, onCleanup, onMount } from "solid-js";
import { SplitPane } from "./SplitPane";
import { Terminal } from "../Terminal/Terminal";
import { ptyKill, ptySpawn } from "../../ipc/pty";
import type { SplitDirection } from "../../types/layout";

type SpawnState =
  | { kind: "spawning" }
  | { kind: "ready"; sessionA: string; sessionB: string }
  | { kind: "failed"; message: string };

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const isWin = typeof navigator !== "undefined" && /Win/.test(navigator.platform);

const defaultShell = (): string => {
  if (isWin) return "powershell.exe";
  return isMac ? "/bin/zsh" : "/bin/bash";
};

const spawnShell = async (label: string): Promise<string> => {
  const resp = await ptySpawn({
    command: defaultShell(),
    args: [],
    env: {
      NODE_ENV: "development",
      WS_LIVE_HARNESS: "splitpane",
      WS_PANE_LABEL: label,
    },
    startupCommands: [`echo "splitpane harness — pane ${label}"`],
    cols: 80,
    rows: 24,
  });
  return resp.sessionId;
};

export function SplitPaneLiveHarness() {
  const [state, setState] = createSignal<SpawnState>({ kind: "spawning" });
  const [direction, setDirection] = createSignal<SplitDirection>("h");
  const [ratio, setRatio] = createSignal(0.5);

  onMount(() => {
    let killOnUnmount: string[] = [];

    if (typeof window !== "undefined" && !("__TAURI_INTERNALS__" in window)) {
      setState({
        kind: "failed",
        message:
          "Open this page inside the Tauri window (the one `pnpm tauri dev` launches). PTY commands aren't available in a plain browser tab.",
      });
      return;
    }

    void (async () => {
      try {
        const [a, b] = await Promise.all([spawnShell("A"), spawnShell("B")]);
        killOnUnmount = [a, b];
        setState({ kind: "ready", sessionA: a, sessionB: b });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setState({ kind: "failed", message });
      }
    })();

    onCleanup(() => {
      for (const id of killOnUnmount) void ptyKill(id);
    });
  });

  return (
    <div class="grid h-full w-full grid-rows-[auto_1fr] gap-2 bg-canvas p-3 text-fg">
      <div class="flex items-center justify-between rounded-md border border-border-default bg-surface p-2 text-xs">
        <div>
          <div class="font-semibold">SplitPane harness (T5.2)</div>
          <div class="mt-1 text-fg-secondary">
            Drag the handle — terminals should freeze, the ghost line moves. Resize / snap-to-50%
            only on pointer up. Ratio: <code class="font-mono">{ratio().toFixed(3)}</code>
          </div>
        </div>
        <div class="flex items-center gap-2">
          <button
            type="button"
            class="rounded border border-border-default px-2 py-1 hover:bg-bg-hover"
            onClick={() => setDirection((d) => (d === "h" ? "v" : "h"))}
          >
            Direction: {direction() === "h" ? "horizontal" : "vertical"}
          </button>
          <button
            type="button"
            class="rounded border border-border-default px-2 py-1 hover:bg-bg-hover"
            onClick={() => setRatio(0.5)}
          >
            Reset 50/50
          </button>
        </div>
      </div>
      <div class="min-h-0 overflow-hidden rounded-md border border-border-default">
        <Switch>
          <Match when={state().kind === "spawning"}>
            <div class="p-3 text-xs text-fg-secondary">Spawning shells…</div>
          </Match>
          <Match when={state().kind === "failed"}>
            <Show when={state().kind === "failed" ? (state() as { message: string }) : null}>
              {(failed) => (
                <div class="p-3 text-xs text-danger">Spawn failed: {failed().message}</div>
              )}
            </Show>
          </Match>
          <Match when={state().kind === "ready"}>
            <Show
              when={
                state().kind === "ready"
                  ? (state() as { sessionA: string; sessionB: string })
                  : null
              }
            >
              {(ready) => (
                <SplitPane
                  direction={direction()}
                  ratio={ratio()}
                  onRatioChange={setRatio}
                  first={
                    <Terminal
                      sessionId={ready().sessionA}
                      title="pane A"
                      projectId="splitpane-harness"
                    />
                  }
                  second={
                    <Terminal
                      sessionId={ready().sessionB}
                      title="pane B"
                      projectId="splitpane-harness"
                    />
                  }
                />
              )}
            </Show>
          </Match>
        </Switch>
      </div>
    </div>
  );
}

export default SplitPaneLiveHarness;
