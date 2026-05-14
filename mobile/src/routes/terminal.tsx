import { createEffect, createSignal, on, onMount, Show } from "solid-js";
import { KeyboardToolbar, Terminal } from "../components/Terminal";
import { SessionsSheet } from "../components/SessionsSheet";
import { bridgeState } from "../stores/wsBridge";
import {
  activeSession,
  activeSessionId,
  hydrateSessions,
  isHydrating,
  sessions,
  spawnSession,
} from "../stores/sessions";

export default function TerminalRoute() {
  const [sheetOpen, setSheetOpen] = createSignal(false);
  const [autoSpawnError, setAutoSpawnError] = createSignal<string | null>(null);
  let autoSpawnPending = false;

  // Once the bridge transitions to "open", re-attach to any cached
  // sessions and auto-spawn a fresh one if the user has none. Watching
  // the bridge state (instead of running hydrate from `onMount`) avoids
  // a race where the bridge hasn't connected yet on the first render.
  createEffect(
    on(bridgeState, (state, prev) => {
      if (state === "open" && prev !== "open") {
        void hydrateSessions().then(maybeAutoSpawn);
      }
    }),
  );

  onMount(() => {
    if (bridgeState() === "open") {
      void hydrateSessions().then(maybeAutoSpawn);
    }
  });

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
      <Show when={bridgeState() === "open"} fallback={<BridgeWaiting state={bridgeState()} />}>
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
          {(sid) => (
            <>
              <Terminal sessionId={sid()} />
              <KeyboardToolbar sessionId={sid()} />
            </>
          )}
        </Show>
      </Show>
      <Show when={sheetOpen()}>
        <SessionsSheet onClose={() => setSheetOpen(false)} />
      </Show>
    </section>
  );
}

function BridgeWaiting(props: { state: string }) {
  return (
    <div class="m-auto flex max-w-sm flex-col items-center gap-3 px-6 text-center">
      <p class="text-sm text-fg-secondary">
        {props.state === "reconnecting"
          ? "Reconnecting to Work Station…"
          : "Waiting for the desktop bridge…"}
      </p>
      <p class="text-xs text-fg-tertiary">
        Sessions resume automatically once the WebSocket comes back online.
      </p>
    </div>
  );
}

function SessionsBar(props: { onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={props.onOpen}
      class="flex w-full min-h-[44px] items-center gap-2 border-b border-border-default bg-elevated/60 px-3 py-1.5 text-left text-xs hover:bg-hover"
      aria-label="Open sessions"
    >
      <Show
        when={activeSession()}
        fallback={<span class="text-fg-tertiary">No active session</span>}
      >
        {(session) => (
          <>
            <span class="size-1.5 rounded-full bg-accent" aria-hidden="true" />
            <span class="truncate font-medium text-fg">{session().label}</span>
            <span class="rounded-full border border-border-default bg-surface px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-fg-secondary">
              {session().cli}
            </span>
          </>
        )}
      </Show>
      <span class="ml-auto text-fg-tertiary">
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
        fallback={<p class="text-sm text-fg-secondary">Restoring sessions…</p>}
      >
        <p class="text-sm text-fg">No active session.</p>
        <Show when={props.error}>
          <p class="text-xs text-error">{props.error}</p>
        </Show>
        <button
          type="button"
          onClick={props.onSpawn}
          class="min-h-[44px] rounded-lg bg-accent px-4 py-2 text-sm font-medium text-canvas hover:bg-accent-muted"
        >
          Start a session
        </button>
      </Show>
    </div>
  );
}
