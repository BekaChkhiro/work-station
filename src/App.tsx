import { Match, Switch, createSignal, onCleanup, onMount } from "solid-js";
import { openUrl } from "@tauri-apps/plugin-opener";
import { AppErrorBoundary, PanelErrorBoundary } from "./components/ErrorBoundary";
import { ErrorThrower } from "./components/ErrorBoundary/ErrorThrower.dev";
import TerminalLiveHarness from "./components/Terminal/Terminal.live.dev";
import TerminalStressHarness from "./components/Terminal/Terminal.stress.dev";
import SplitPaneLiveHarness from "./components/SplitPane/SplitPane.live.dev";
import TabStripLiveHarness from "./components/TabStrip/TabStrip.live.dev";
import LayoutTreeLiveHarness from "./components/LayoutTree/LayoutTree.live.dev";
import PaneLiveHarness from "./components/Pane/Pane.live.dev";
import SidebarLiveHarness from "./components/Sidebar/Sidebar.live.dev";
import AppShellLiveHarness from "./components/AppShell/AppShell.live.dev";
import AddProjectModalLiveHarness from "./components/AddProjectModal/AddProjectModal.live.dev";
import EditProjectFlowLiveHarness from "./components/EditProjectFlow/EditProjectFlow.live.dev";
import ProjectsEmptyStateLiveHarness from "./components/ProjectsEmptyState/ProjectsEmptyState.live.dev";
import AsyncStatesLiveHarness from "./components/AsyncStates/AsyncStates.live.dev";
import { AppRoot } from "./components/AppRoot";
import { CloudConnectionBanner } from "./components/CloudConnectionBanner";
import TokenShowcase from "./components/TokenShowcase";
import { CrossSessionSearch } from "./components/CrossSessionSearch";
import { HotkeyCheatsheet } from "./components/HotkeyCheatsheet";
import { QuickSwitcher } from "./components/QuickSwitcher";
import { ToastRegion } from "./components/Toast";
import { eventMatchesBinding, getBinding } from "./hotkeys";
import {
  DEFAULT_ACCOUNT,
  Integration,
  getCredential,
  installAutoReplay,
  installOfflineListeners,
} from "./integrations";
import { installCloudAgentAutoConnect, installCloudAutoReplay } from "./integrations/cloudAgent";
import { getCloudAgentManager } from "./ipc/transport";
import { addMenuActionListener, bridgeNativeMenuActions, dispatchMenuAction } from "./menu";
import { isEditableTarget } from "./utils/platform";
import "./styles/globals.css";

type DebugMode =
  | "errorboundary"
  | "terminal-stress"
  | "terminal"
  | "splitpane"
  | "tabstrip"
  | "layouttree"
  | "pane"
  | "sidebar"
  | "appshell"
  | "addproject"
  | "editproject"
  | "projectsempty"
  | "asyncstates"
  | "tokens"
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
    v === "pane" ||
    v === "sidebar" ||
    v === "appshell" ||
    v === "addproject" ||
    v === "editproject" ||
    v === "projectsempty" ||
    v === "asyncstates" ||
    v === "tokens"
    ? v
    : null;
};

export default function App() {
  const [crossSearchOpen, setCrossSearchOpen] = createSignal(false);
  const [switcherOpen, setSwitcherOpen] = createSignal(false);
  const [cheatsheetOpen, setCheatsheetOpen] = createSignal(false);

  // T4.13: Cmd/Ctrl+Shift+F opens cross-session search. Bound at the
  // document level so any focused pane (xterm steals key events via its
  // textarea) can still trigger it. The Terminal's customKeyEventHandler
  // returns false for shift+f so xterm doesn't send `^F` to the shell;
  // the event still bubbles to here and we handle it.
  //
  // T6.4: Cmd/Ctrl+K opens the quick switcher. Same document-level binding
  // for the same reason — xterm consumes keystrokes from a hidden textarea
  // and we need the modifier combo to win even while a terminal pane has
  // focus.
  onMount(() => {
    // T11.9 — install network listeners and the offline → online auto-replay
    // wiring once at app boot. Both helpers are idempotent and the dispose
    // fns are kept so HMR / unmount tears them down cleanly. The replay
    // context lazily re-resolves each integration's token at retry time so
    // a token rotation between enqueue and reconnect doesn't replay a stale
    // Authorization header.
    const disposeOfflineListeners = installOfflineListeners();
    const disposeAutoReplay = installAutoReplay({
      getAuthToken: async (service): Promise<string | null> => {
        if (service === Integration.PlanFlow) {
          return getCredential(Integration.PlanFlow, DEFAULT_ACCOUNT);
        }
        // Other integrations (GitHub, Vercel, …) register their own
        // replay handlers when their tabs ship; until then there is no
        // token to resolve.
        return null;
      },
    });

    // T19.16 — wire the cloud-agent manager into the cloud-mode signal so
    // the dial/teardown lifecycle follows the toggle, and install the
    // offline-queue auto-replay so writes queued during a drop drain on
    // reconnect. Both helpers are idempotent and share the singleton
    // manager from `getCloudAgentManager()` (transport.ts), so the routing
    // layer, the connection banner, and the queue all observe the same
    // state.
    const cloudManager = getCloudAgentManager();
    const disposeCloudAutoConnect = installCloudAgentAutoConnect(cloudManager);
    const disposeCloudReplay = installCloudAutoReplay(cloudManager);

    let unlistenNative: (() => void) | undefined;
    if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
      void bridgeNativeMenuActions().then((dispose) => {
        unlistenNative = dispose;
      });
    }
    const disposeMenu = addMenuActionListener((id) => {
      if (id === "quick-switcher") {
        setSwitcherOpen((open) => !open);
        return;
      }
      if (id === "documentation") {
        void openUrl("https://tauri.app/");
        return;
      }
      if (id === "report-issue") {
        void openUrl("https://github.com/");
        return;
      }
      if (id === "about") {
        window.alert("Work Station 0.1.0");
      }
    });
    const handler = (e: KeyboardEvent) => {
      const crossFind = getBinding("find-cross-session");
      if (crossFind && eventMatchesBinding(e, crossFind)) {
        e.preventDefault();
        setCrossSearchOpen(true);
        return;
      }
      const switcher = getBinding("quick-switcher");
      if (switcher && eventMatchesBinding(e, switcher)) {
        // Mirror T6.3's editable-target guard so Cmd+K doesn't steal focus
        // while the user is typing in a shell or input. The switcher itself
        // ignores this guard because its own input is already mounted by
        // the time it dispatches keys.
        if (isEditableTarget(document.activeElement)) return;
        e.preventDefault();
        setSwitcherOpen((open) => !open);
        return;
      }
      // T8.2 — Cmd+/ toggles the hotkey cheatsheet. Document-level so it
      // wins over xterm; xterm's `customKeyEventHandler` already iterates
      // listActions() and returns false for any registered binding, so the
      // shell never sees the keystroke.
      const cheatsheet = getBinding("show-cheatsheet");
      if (cheatsheet && eventMatchesBinding(e, cheatsheet)) {
        e.preventDefault();
        setCheatsheetOpen((open) => !open);
        return;
      }
    };
    document.addEventListener("keydown", handler);
    onCleanup(() => {
      document.removeEventListener("keydown", handler);
      disposeMenu();
      unlistenNative?.();
      disposeAutoReplay();
      disposeOfflineListeners();
      disposeCloudReplay();
      disposeCloudAutoConnect();
    });
  });

  const cloudManagerForBanner = getCloudAgentManager();

  return (
    <AppErrorBoundary>
      {/* T19.16 — global cloud-agent connection banner. Renders above any
       *  panel content so it's visible regardless of which AppShell / dev
       *  harness is mounted below. Hidden when cloud mode is off or the
       *  agent is open. */}
      <CloudConnectionBanner
        state={cloudManagerForBanner.state}
        onAction={() => dispatchMenuAction("open-settings")}
      />
      <PanelErrorBoundary scope="panel">
        <Switch fallback={<AppRoot />}>
          <Match when={debugMode() === "tokens"}>
            <TokenShowcase />
          </Match>
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
          <Match when={debugMode() === "sidebar"}>
            <SidebarLiveHarness />
          </Match>
          <Match when={debugMode() === "appshell"}>
            <AppShellLiveHarness />
          </Match>
          <Match when={debugMode() === "addproject"}>
            <AddProjectModalLiveHarness />
          </Match>
          <Match when={debugMode() === "editproject"}>
            <EditProjectFlowLiveHarness />
          </Match>
          <Match when={debugMode() === "projectsempty"}>
            <ProjectsEmptyStateLiveHarness />
          </Match>
          <Match when={debugMode() === "asyncstates"}>
            <AsyncStatesLiveHarness />
          </Match>
        </Switch>
      </PanelErrorBoundary>
      <CrossSessionSearch open={crossSearchOpen()} onClose={() => setCrossSearchOpen(false)} />
      <QuickSwitcher open={switcherOpen()} onClose={() => setSwitcherOpen(false)} />
      <HotkeyCheatsheet open={cheatsheetOpen()} onClose={() => setCheatsheetOpen(false)} />
      {/* T11.9 — Single mount point for the offline / queue toasts. */}
      <ToastRegion />
    </AppErrorBoundary>
  );
}
