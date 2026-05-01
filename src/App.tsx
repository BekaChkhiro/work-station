import { Show } from "solid-js";
import { AppErrorBoundary, PanelErrorBoundary } from "./components/ErrorBoundary";
import { ErrorThrower } from "./components/ErrorBoundary/ErrorThrower.dev";
import TokenShowcase from "./components/TokenShowcase";
import "./styles/globals.css";

const isErrorBoundaryDebug = (): boolean => {
  if (!import.meta.env.DEV || typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("wsdebug") === "errorboundary";
};

export default function App() {
  return (
    <AppErrorBoundary>
      <PanelErrorBoundary scope="panel">
        <Show when={isErrorBoundaryDebug()} fallback={<TokenShowcase />}>
          <ErrorThrower />
        </Show>
      </PanelErrorBoundary>
    </AppErrorBoundary>
  );
}
