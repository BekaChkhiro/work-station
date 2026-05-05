// Dev-only single-pane harness: spawns one shell and renders it through the
// Terminal component so you can manually exercise PTY + xterm features
// (env vars, .zshrc aliases, copy/paste, search, links, scrollback) without
// the project sidebar / layout that lands in Phase 5/6.

import { Match, Show, Switch, createSignal, onCleanup, onMount } from "solid-js";
import { Terminal } from "./Terminal";
import { ptyKill, ptySpawn } from "../../ipc/pty";

type SpawnState =
  | { kind: "spawning" }
  | { kind: "ready"; sessionId: string }
  | { kind: "failed"; message: string };

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const isWin = typeof navigator !== "undefined" && /Win/.test(navigator.platform);

// Fallback shell guess by platform — the harness is dev-only so we don't
// need the full CLI-detection from Phase 7 (T7.1) here.
const defaultShell = (): string => {
  if (isWin) return "powershell.exe";
  return isMac ? "/bin/zsh" : "/bin/bash";
};

export function TerminalLiveHarness() {
  const [state, setState] = createSignal<SpawnState>({ kind: "spawning" });

  onMount(() => {
    let killOnUnmount: string | null = null;

    void (async () => {
      try {
        const resp = await ptySpawn({
          command: defaultShell(),
          args: [],
          env: {
            // Visible probe for the env-vars acceptance check (T4.14).
            NODE_ENV: "development",
            WS_LIVE_HARNESS: "1",
          },
          startupCommands: ['echo "work-station live terminal — type away."'],
          cols: 120,
          rows: 32,
        });
        killOnUnmount = resp.sessionId;
        setState({ kind: "ready", sessionId: resp.sessionId });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setState({ kind: "failed", message });
      }
    })();

    onCleanup(() => {
      if (killOnUnmount) void ptyKill(killOnUnmount);
    });
  });

  return (
    <div class="grid h-full w-full grid-rows-[auto_1fr] gap-2 bg-canvas p-3 text-fg">
      <div class="rounded-md border border-border-default bg-surface p-2 text-xs">
        <div class="font-semibold">Live terminal harness</div>
        <div class="mt-1 text-fg-secondary">
          Shell: <code class="font-mono">{defaultShell()}</code>. Env probe:{" "}
          <code class="font-mono">NODE_ENV=development</code>. Try{" "}
          <code class="font-mono">echo $NODE_ENV</code>, your aliases, Cmd+F (in-pane search),
          Cmd+Shift+F (cross-session search).
        </div>
      </div>
      <div class="min-h-0 overflow-hidden rounded-md border border-border-default">
        <Switch>
          <Match when={state().kind === "spawning"}>
            <div class="p-3 text-xs text-fg-secondary">Spawning shell…</div>
          </Match>
          <Match when={state().kind === "failed"}>
            <Show when={state().kind === "failed" ? (state() as { message: string }) : null}>
              {(failed) => (
                <div class="p-3 text-xs text-danger">Spawn failed: {failed().message}</div>
              )}
            </Show>
          </Match>
          <Match when={state().kind === "ready"}>
            <Show when={state().kind === "ready" ? (state() as { sessionId: string }) : null}>
              {(ready) => (
                <Terminal sessionId={ready().sessionId} title="live" projectId="live-harness" />
              )}
            </Show>
          </Match>
        </Switch>
      </div>
    </div>
  );
}

export default TerminalLiveHarness;
