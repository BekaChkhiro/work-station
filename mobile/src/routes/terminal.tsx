import { createSignal, Show } from "solid-js";
import { Terminal } from "../components/Terminal";
import {
  readBridgeConfig,
  resetBridge,
  writeBridgeConfig,
  type BridgeConfig,
} from "../stores/wsBridge";

export default function TerminalRoute() {
  const [config, setConfig] = createSignal<BridgeConfig | null>(readBridgeConfig());

  return (
    <section
      class="flex flex-col"
      style={{
        height: "calc(100vh - 72px - env(safe-area-inset-top) - env(safe-area-inset-bottom))",
      }}
    >
      <Show
        when={config()}
        fallback={
          <ConnectionForm
            onSave={(c) => {
              writeBridgeConfig(c);
              resetBridge();
              setConfig(c);
            }}
          />
        }
      >
        <Terminal />
      </Show>
    </section>
  );
}

function ConnectionForm(props: { onSave: (c: BridgeConfig) => void }) {
  const [url, setUrl] = createSignal("ws://127.0.0.1:7420/ws");
  const [token, setToken] = createSignal("");

  return (
    <form
      class="m-auto flex w-full max-w-sm flex-col gap-3 rounded-lg border border-neutral-800 bg-neutral-900/60 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        const u = url().trim();
        const t = token().trim();
        if (!u || !t) return;
        props.onSave({ url: u, token: t });
      }}
    >
      <h2 class="text-base font-semibold">Connect to Work Station</h2>
      <p class="text-xs text-neutral-400">
        Enter the WebSocket URL and bearer token from Work Station → Settings → Mobile bridge.
      </p>
      <label class="flex flex-col gap-1 text-xs text-neutral-300">
        URL
        <input
          type="url"
          autocomplete="url"
          required
          value={url()}
          onInput={(e) => setUrl(e.currentTarget.value)}
          class="rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-100 outline-none focus:border-cyan-500"
        />
      </label>
      <label class="flex flex-col gap-1 text-xs text-neutral-300">
        Token
        <input
          type="password"
          required
          value={token()}
          onInput={(e) => setToken(e.currentTarget.value)}
          class="rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-100 outline-none focus:border-cyan-500"
        />
      </label>
      <button
        type="submit"
        class="mt-1 rounded bg-cyan-500 px-3 py-2 text-sm font-medium text-neutral-950 hover:bg-cyan-400"
      >
        Connect
      </button>
    </form>
  );
}
