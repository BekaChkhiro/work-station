import { Match, Switch, createSignal, onCleanup, onMount } from "solid-js";
import { AppErrorBoundary, PanelErrorBoundary } from "./components/ErrorBoundary";
import { ErrorThrower } from "./components/ErrorBoundary/ErrorThrower.dev";
import TerminalLiveHarness from "./components/Terminal/Terminal.live.dev";
import TerminalStressHarness from "./components/Terminal/Terminal.stress.dev";
import SplitPaneLiveHarness from "./components/SplitPane/SplitPane.live.dev";
import TabStripLiveHarness from "./components/TabStrip/TabStrip.live.dev";
import LayoutTreeLiveHarness from "./components/LayoutTree/LayoutTree.live.dev";
import PaneLiveHarness from "./components/Pane/Pane.live.dev";
import TokenShowcase from "./components/TokenShowcase";
import { CrossSessionSearch } from "./components/CrossSessionSearch";
import "./styles/globals.css";

type DebugMode =
  | "errorboundary"
  | "terminal-stress"
  | "terminal"
  | "splitpane"
  | "tabstrip"
  | "layouttree"
  | "pane"
  | null;

const debugMode = (): DebugMode => {
  if (!import.meta.env.DEV || typeof window === "undefined") return null;
  const v = new URLSearchParams(window.location.search).get("wsdebug");
  return v === "errorboundary" ||
    v === "terminal-stress" ||
    v === "terminal" ||
    v === "splitpane" ||
    v === "tabstrip" ||
    v === "layouttree" ||
    v === "pane"
    ? v
    : null;
};

export default function App() {
  const [crossSearchOpen, setCrossSearchOpen] = createSignal(false);

  // T4.13: Cmd/Ctrl+Shift+F opens cross-session search. Bound at the
  // document level so any focused pane (xterm steals key events via its
  // textarea) can still trigger it. The Terminal's customKeyEventHandler
  // returns false for shift+f so xterm doesn't send `^F` to the shell;
  // the event still bubbles to here and we handle it.
  onMount(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || e.altKey || !e.shiftKey) return;
      if (e.key.toLowerCase() !== "f") return;
      e.preventDefault();
      setCrossSearchOpen(true);
    };
    document.addEventListener("keydown", handler);
    onCleanup(() => document.removeEventListener("keydown", handler));
  });

  return (
    <AppErrorBoundary>
      <PanelErrorBoundary scope="panel">
        <Switch fallback={<TokenShowcase />}>
          <Match when={debugMode() === "errorboundary"}>
            <ErrorThrower />
          </Match>
          <Match when={debugMode() === "terminal-stress"}>
            <TerminalStressHarness />
          </Match>
          <Match when={debugMode() === "terminal"}>
            <TerminalLiveHarness />
          </Match>
          <Match when={debugMode() === "splitpane"}>
            <SplitPaneLiveHarness />
          </Match>
          <Match when={debugMode() === "tabstrip"}>
            <TabStripLiveHarness />
          </Match>
          <Match when={debugMode() === "layouttree"}>
            <LayoutTreeLiveHarness />
          </Match>
          <Match when={debugMode() === "pane"}>
            <PaneLiveHarness />
          </Match>
        </Switch>
      </PanelErrorBoundary>
      <CrossSessionSearch open={crossSearchOpen()} onClose={() => setCrossSearchOpen(false)} />
    </AppErrorBoundary>
  );
}
