import { Router } from "@solidjs/router";
import { FileRoutes } from "@solidjs/start/router";
import { Show, Suspense, onMount } from "solid-js";
import { Shell } from "./components/Shell";
import { AuthScreen } from "./components/AuthScreen";
import { UpdateToast } from "./components/UpdateToast";
import { authStore, connect } from "./lib/auth";
import { parsePairingPayload, stripPairingParamsFromUrl } from "./lib/pairing";
import "./app.css";

export default function App() {
  // Boot order:
  //   1. If the URL carries pairing params (QR scan -> camera app -> us),
  //      use them, scrub them from the address bar, and connect. They
  //      take precedence over stored credentials so a QR can pivot to a
  //      different host.
  //   2. Otherwise re-probe stored credentials so a returning user
  //      lands on the tab bar instead of the auth form.
  onMount(() => {
    if (typeof window !== "undefined") {
      const payload = parsePairingPayload(window.location.href);
      if (payload) {
        stripPairingParamsFromUrl();
        void connect(payload.host, payload.token);
        return;
      }
    }
    if (authStore.hasStoredCredentials()) {
      void connect(authStore.host(), authStore.token());
    }
  });

  return (
    <>
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
      <UpdateToast />
    </>
  );
}
