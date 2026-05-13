import { createSignal, onMount, Show } from "solid-js";
import { Terminal } from "../components/Terminal";
import { SessionsSheet } from "../components/SessionsSheet";
import {
  readBridgeConfig,
  resetBridge,
  writeBridgeConfig,
  type BridgeConfig,
} from "../stores/wsBridge";
import {
  activeSession,
  activeSessionId,
  hydrateSessions,
  isHydrating,
  sessions,
  spawnSession,
} from "../stores/sessions";

export default function TerminalRoute() {
  const [config, setConfig] = createSignal<BridgeConfig | null>(readBridgeConfig());
  const [sheetOpen, setSheetOpen] = createSignal(false);
  const [autoSpawnError, setAutoSpawnError] = createSignal<string | null>(null);
  let autoSpawnPending = false;

  onMount(() => {
    if (config()) {
      void hydrateSessions().then(maybeAutoSpawn);
    }
  });

  // When we have a configured bridge but no sessions, auto-spawn one so
  // the user lands on a usable terminal instead of an empty state on
  // first visit. We guard with `autoSpawnPending` so re-renders during
  // hydration don't trigger multiple spawns.
  function maybeAutoSpawn() {
    if (autoSpawnPending) return;
    if (isHydrating()) return;
    if (sessions().length > 0) return;
    autoSpawnPending = true;
    spawnSession()
      .catch((err) => {
        setAutoSpawnError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        autoSpawnPending = false;
      });
  }

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
              void hydrateSessions().then(maybeAutoSpawn);
            }}
          />
        }
      >
        <SessionsBar onOpen={() => setSheetOpen(true)} />
        <Show
          when={activeSessionId()}
          fallback={
            <EmptySessions
              hydrating={isHydrating()}
              error={autoSpawnError()}
              onSpawn={() => {
                setAutoSpawnError(null);
                maybeAutoSpawn();
              }}
            />
          }
        >
          {(sid) => <Terminal sessionId={sid()} />}
        </Show>
      </Show>
      <Show when={sheetOpen()}>
        <SessionsSheet onClose={() => setSheetOpen(false)} />
      </Show>
    </section>
  );
}

function SessionsBar(props: { onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={props.onOpen}
      class="flex w-full min-h-[44px] items-center gap-2 border-b border-neutral-800 bg-neutral-900/60 px-3 py-1.5 text-left text-xs hover:bg-neutral-900"
      aria-label="Open sessions"
    >
      <Show
        when={activeSession()}
        fallback={<span class="text-neutral-400">No active session</span>}
      >
        {(session) => (
          <>
            <span class="size-1.5 rounded-full bg-cyan-400" aria-hidden="true" />
            <span class="truncate font-medium text-neutral-100">{session().label}</span>
            <span class="rounded-full border border-neutral-700 bg-neutral-950 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-neutral-300">
              {session().cli}
            </span>
          </>
        )}
      </Show>
      <span class="ml-auto text-neutral-500">
        {sessions().length} session{sessions().length === 1 ? "" : "s"} ▾
      </span>
    </button>
  );
}

function EmptySessions(props: { hydrating: boolean; error: string | null; onSpawn: () => void }) {
  return (
    <div class="m-auto flex max-w-sm flex-col items-center gap-3 px-6 text-center">
      <Show
        when={!props.hydrating}
        fallback={<p class="text-sm text-neutral-400">Restoring sessions…</p>}
      >
        <p class="text-sm text-neutral-300">No active session.</p>
        <Show when={props.error}>
          <p class="text-xs text-red-400">{props.error}</p>
        </Show>
        <button
          type="button"
          onClick={props.onSpawn}
          class="min-h-[44px] rounded-lg bg-cyan-500 px-4 py-2 text-sm font-medium text-neutral-950 hover:bg-cyan-400"
        >
          Start a session
        </button>
      </Show>
    </div>
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
