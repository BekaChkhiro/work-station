import { Router } from "@solidjs/router";
import { FileRoutes } from "@solidjs/start/router";
import { Show, Suspense, onMount } from "solid-js";
import { Shell } from "./components/Shell";
import { AuthScreen } from "./components/AuthScreen";
import { authStore, connect } from "./lib/auth";
import "./app.css";

export default function App() {
  // If credentials were restored from localStorage, silently re-probe so
  // a returning user lands on the tab bar instead of the auth form when
  // the server is up. A failed probe routes them back to AuthScreen
  // with the right error message.
  onMount(() => {
    if (authStore.hasStoredCredentials()) {
      void connect(authStore.host(), authStore.token());
    }
  });

  return (
    <Show when={authStore.isAuthenticated()} fallback={<AuthScreen />}>
      <Router
        root={(props) => (
          <Shell>
            <Suspense>{props.children}</Suspense>
          </Shell>
        )}
      >
        <FileRoutes />
      </Router>
    </Show>
  );
}
