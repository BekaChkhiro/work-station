import { Match, Switch } from "solid-js";
import { AppErrorBoundary, PanelErrorBoundary } from "./components/ErrorBoundary";
import { ErrorThrower } from "./components/ErrorBoundary/ErrorThrower.dev";
import TerminalStressHarness from "./components/Terminal/Terminal.stress.dev";
import TokenShowcase from "./components/TokenShowcase";
import "./styles/globals.css";

type DebugMode = "errorboundary" | "terminal-stress" | null;

const debugMode = (): DebugMode => {
  if (!import.meta.env.DEV || typeof window === "undefined") return null;
  const v = new URLSearchParams(window.location.search).get("wsdebug");
  return v === "errorboundary" || v === "terminal-stress" ? v : null;
};

export default function App() {
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
        </Switch>
      </PanelErrorBoundary>
    </AppErrorBoundary>
  );
}
