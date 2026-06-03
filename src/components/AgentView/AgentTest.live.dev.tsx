// Dev-only harness (`?wsdebug=agent-test`): the rich Claude Code Agent view
// side-by-side with raw Codex and Kimi terminals — the "Claude as GUI, the
// others as terminals, all in one workspace" demo from the cmux competitive
// analysis. Open inside the Tauri window (`pnpm tauri dev`).

import { Match, Show, Switch, createSignal, onCleanup, onMount } from "solid-js";
import { AgentView } from "./AgentView";
import { Terminal } from "../Terminal";
import { ptyKill, ptySpawn } from "../../ipc/pty";

const inTauri = (): boolean => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

type SpawnState =
  | { kind: "spawning" }
  | { kind: "ready"; sessionId: string }
  | { kind: "failed"; message: string };

interface CliTerminalProps {
  command: string;
  label: string;
}

/** Spawns one agent CLI in a PTY and renders it through the Terminal
 *  component — the existing raw-terminal path, unchanged. */
function CliTerminal(props: CliTerminalProps) {
  const [state, setState] = createSignal<SpawnState>({ kind: "spawning" });

  onMount(() => {
    let killOnUnmount: string | null = null;
    void (async () => {
      try {
        const resp = await ptySpawn({
          command: props.command,
          args: [],
          env: {},
          cols: 100,
          rows: 32,
        });
        killOnUnmount = resp.sessionId;
        setState({ kind: "ready", sessionId: resp.sessionId });
      } catch (error) {
        setState({
          kind: "failed",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })();
    onCleanup(() => {
      if (killOnUnmount) void ptyKill(killOnUnmount);
    });
  });

  return (
    <Switch>
      <Match when={state().kind === "spawning"}>
        <div class="p-3 text-xs text-fg-secondary">Spawning {props.label}…</div>
      </Match>
      <Match when={state().kind === "failed"}>
        <Show when={state().kind === "failed" ? (state() as { message: string }) : null}>
          {(failed) => (
            <div class="p-3 text-xs text-danger">
              {props.label} failed: {failed().message}
            </div>
          )}
        </Show>
      </Match>
      <Match when={state().kind === "ready"}>
        <Show when={state().kind === "ready" ? (state() as { sessionId: string }) : null}>
          {(ready) => (
            <Terminal sessionId={ready().sessionId} title={props.label} projectId="agent-test" />
          )}
        </Show>
      </Match>
    </Switch>
  );
}

export function AgentTestHarness() {
  return (
    <div class="flex h-full w-full flex-col bg-canvas text-fg">
      <div class="border-b border-border-default bg-surface px-3 py-2 text-xs">
        <span class="font-semibold">Agent test harness</span>
        <span class="ml-2 text-fg-secondary">
          Claude Code (rich stream-json view) · Codex · Kimi — side by side.
        </span>
        <Show when={!inTauri()}>
          <span class="ml-2 text-danger">
            Open inside the Tauri window — `pnpm tauri dev` — not a browser tab.
          </span>
        </Show>
      </div>
      <div class="grid min-h-0 flex-1 grid-cols-1 gap-px bg-border-default md:grid-cols-3">
        <div class="min-h-0 overflow-hidden bg-canvas">
          <AgentView sessionId="agent-test" title="Claude Code" permissionMode="acceptEdits" />
        </div>
        <div class="min-h-0 overflow-hidden bg-canvas">
          <CliTerminal command="codex" label="Codex" />
        </div>
        <div class="min-h-0 overflow-hidden bg-canvas">
          <CliTerminal command="kimi" label="Kimi" />
        </div>
      </div>
    </div>
  );
}

export default AgentTestHarness;
