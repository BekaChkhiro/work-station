// Dev-only harness: LayoutTree wrapping multiple PTY-backed Terminals so
// the T5.4 acceptance can be exercised manually:
//
//   • Drag any split handle. Terminals freeze during drag (T5.2 ghost
//     line tracks the cursor) and only commit on release.
//   • A "Drag handle 100×" button programmatically nudges the root
//     ratio 100 times. Each pane shows its own mount counter — the
//     counter must stay at 1 across the run.
//   • "Set initial layout" picks one of three preset trees: a single
//     pane, a horizontal 2-pane split, or a 3-pane T-split. Switching
//     the layout SHAPE remounts terminals (structurally different
//     panes); just changing ratios does not.
//
// Reachable via `?wsdebug=layouttree` in dev builds.

import { Match, Show, Switch, createSignal, onCleanup, onMount } from "solid-js";
import type { JSX } from "solid-js";
import { LayoutTree } from "./LayoutTree";
import { Terminal } from "../Terminal/Terminal";
import { ptyKill, ptySpawn } from "../../ipc/pty";
import {
  paneNode,
  splitNode,
  updateSplitRatio,
  type LayoutNode,
  type LayoutPath,
} from "../../types/layout";

type SpawnState =
  | { kind: "spawning" }
  | {
      kind: "ready";
      sessions: { a: string; b: string; c: string };
    }
  | { kind: "failed"; message: string };

type LayoutShape = "single" | "h-split" | "t-split";

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
      WS_LIVE_HARNESS: "layouttree",
      WS_PANE_LABEL: label,
    },
    startupCommands: [`echo "layouttree harness — pane ${label}"`],
    cols: 80,
    rows: 24,
  });
  return resp.sessionId;
};

// Module-scoped registry: pane sessionId → mount count. Lives outside the
// component so the counter survives re-renders and only increments when a
// Terminal actually mounts (not when its props update reactively).
const mountCounts = new Map<string, number>();

interface CountedTerminalProps {
  sessionId: string;
  label: string;
  /** Notifies the harness UI so it can re-read mountCounts and render. */
  onMounted: () => void;
}

function CountedTerminal(props: CountedTerminalProps): JSX.Element {
  onMount(() => {
    const next = (mountCounts.get(props.sessionId) ?? 0) + 1;
    mountCounts.set(props.sessionId, next);
    props.onMounted();
  });
  return (
    <div class="relative h-full w-full">
      <div class="absolute right-1 top-1 z-10 rounded bg-bg-tertiary px-2 py-0.5 font-mono text-[10px] text-fg-secondary">
        pane {props.label} · mounts {mountCounts.get(props.sessionId) ?? 0}
      </div>
      <Terminal
        sessionId={props.sessionId}
        title={`pane ${props.label}`}
        projectId="layouttree-harness"
      />
    </div>
  );
}

const buildLayout = (
  shape: LayoutShape,
  sessions: { a: string; b: string; c: string },
): LayoutNode => {
  if (shape === "single") return paneNode(sessions.a);
  if (shape === "h-split") {
    return splitNode("h", paneNode(sessions.a), paneNode(sessions.b), 0.5);
  }
  // t-split: vertical handle on top half, horizontal handle splits the
  // bottom into two — exercises the path encoding (root + "R" subtree).
  return splitNode(
    "v",
    paneNode(sessions.a),
    splitNode("h", paneNode(sessions.b), paneNode(sessions.c), 0.5),
    0.5,
  );
};

export function LayoutTreeLiveHarness() {
  const [state, setState] = createSignal<SpawnState>({ kind: "spawning" });
  const [shape, setShape] = createSignal<LayoutShape>("h-split");
  const [tree, setTree] = createSignal<LayoutNode | null>(null);
  // Bumped whenever a Terminal mounts so the JSX re-reads mountCounts. The
  // counter map is the source of truth; this signal is just a render kick.
  const [mountTick, setMountTick] = createSignal(0);
  const [autoDragRunning, setAutoDragRunning] = createSignal(false);
  // T5.5 — focused pane sessionId. Starts at the first pane's id once we
  // know it; click any pane to switch. Verifies the Pane focus ring
  // tracks click events and the contract bubbles through LayoutTree.
  const [focusedSessionId, setFocusedSessionId] = createSignal<string | null>(null);

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
        const [a, b, c] = await Promise.all([spawnShell("A"), spawnShell("B"), spawnShell("C")]);
        killOnUnmount = [a, b, c];
        const sessions = { a, b, c };
        setState({ kind: "ready", sessions });
        setTree(buildLayout(shape(), sessions));
        setFocusedSessionId(a);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setState({ kind: "failed", message });
      }
    })();

    onCleanup(() => {
      mountCounts.clear();
      for (const id of killOnUnmount) void ptyKill(id);
    });
  });

  const handleRatioChange = (path: LayoutPath, ratio: number): void => {
    setTree((prev) => (prev ? updateSplitRatio(prev, path, ratio) : prev));
  };

  const handleMounted = (): void => {
    setMountTick((t) => t + 1);
  };

  const handleShapeChange = (next: LayoutShape): void => {
    setShape(next);
    const s = state();
    if (s.kind === "ready") setTree(buildLayout(next, s.sessions));
    // Switching shape may unmount/remount panes — that's the spec, so
    // we DON'T reset mountCounts here. The user can verify the counter
    // increments only on shape changes, never on ratio drags.
  };

  // Programmatically nudge each split's ratio 100 times. If LayoutTree
  // is correct, every Terminal still reads "mounts 1" after the run; if
  // it isn't, the counter goes up. For the t-split preset we alternate
  // between the root ("") and the nested ("R") split so both handles
  // are exercised, not just the outermost one.
  const runAutoDrag = async (): Promise<void> => {
    if (autoDragRunning()) return;
    setAutoDragRunning(true);
    try {
      const paths: LayoutPath[] = shape() === "t-split" ? ["", "R"] : [""];
      for (let i = 0; i < 100; i++) {
        const r = 0.3 + (i % 41) * 0.01; // sweeps 0.30 → 0.70 and wraps
        const path = paths[i % paths.length] ?? "";
        handleRatioChange(path, r);
        // Yield to the event loop so Solid commits each update — without
        // this the loop runs synchronously and we can't observe paints.
        await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
      }
    } finally {
      setAutoDragRunning(false);
    }
  };

  const renderPane = (sessionId: string): JSX.Element => {
    const s = state();
    if (s.kind !== "ready") return null;
    const label = sessionId === s.sessions.a ? "A" : sessionId === s.sessions.b ? "B" : "C";
    return <CountedTerminal sessionId={sessionId} label={label} onMounted={handleMounted} />;
  };

  const mountSummary = (): string => {
    mountTick(); // track
    const s = state();
    if (s.kind !== "ready") return "—";
    const ids = [s.sessions.a, s.sessions.b, s.sessions.c];
    return ids.map((id, i) => `${"ABC"[i]}=${mountCounts.get(id) ?? 0}`).join("  ");
  };

  return (
    <div class="grid h-full w-full grid-rows-[auto_1fr] gap-2 bg-canvas p-3 text-fg">
      <div class="rounded-md border border-border-default bg-surface p-2 text-xs">
        <div class="font-semibold">LayoutTree harness (T5.4)</div>
        <div class="mt-1 text-fg-secondary">
          Drag any split handle and watch the per-pane mount counters in the top-right of each
          terminal. Acceptance: 100 drags must keep every counter at 1.
        </div>
        <div class="mt-2 flex flex-wrap items-center gap-2">
          <div class="flex items-center gap-1">
            <span class="text-fg-tertiary">Layout:</span>
            <button
              type="button"
              class="rounded border border-border-default px-2 py-1 hover:bg-bg-hover"
              data-active={shape() === "single" ? "true" : undefined}
              onClick={() => handleShapeChange("single")}
            >
              single
            </button>
            <button
              type="button"
              class="rounded border border-border-default px-2 py-1 hover:bg-bg-hover"
              data-active={shape() === "h-split" ? "true" : undefined}
              onClick={() => handleShapeChange("h-split")}
            >
              h-split
            </button>
            <button
              type="button"
              class="rounded border border-border-default px-2 py-1 hover:bg-bg-hover"
              data-active={shape() === "t-split" ? "true" : undefined}
              onClick={() => handleShapeChange("t-split")}
            >
              t-split
            </button>
          </div>
          <button
            type="button"
            class="rounded border border-border-default px-2 py-1 hover:bg-bg-hover"
            onClick={() => void runAutoDrag()}
            disabled={autoDragRunning() || state().kind !== "ready"}
          >
            {autoDragRunning() ? "Dragging…" : "Drag handle 100×"}
          </button>
          <div class="ml-auto flex gap-3 font-mono text-fg-secondary">
            <span>
              focus:{" "}
              <span class="text-fg">
                {(() => {
                  const id = focusedSessionId();
                  const s = state();
                  if (!id || s.kind !== "ready") return "—";
                  return id === s.sessions.a ? "A" : id === s.sessions.b ? "B" : "C";
                })()}
              </span>
            </span>
            <span>
              mounts: <span class="text-fg">{mountSummary()}</span>
            </span>
          </div>
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
          <Match when={state().kind === "ready" && tree() !== null}>
            <Show when={tree()}>
              {(node) => (
                <LayoutTree
                  node={node()}
                  renderPane={renderPane}
                  onRatioChange={handleRatioChange}
                  focusedSessionId={focusedSessionId()}
                  onFocusPane={setFocusedSessionId}
                />
              )}
            </Show>
          </Match>
        </Switch>
      </div>
    </div>
  );
}

export default LayoutTreeLiveHarness;
