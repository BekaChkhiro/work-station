// T18.13 — Slide-up sheet listing active PTY sessions.
//
// Lives over the Terminal route. Each row shows the project label and a
// CLI badge; tap switches the active terminal, swipe-left reveals a
// destructive "Kill" action. The "+ New session" row spawns a PTY in
// the currently-selected PlanFlow project's context.

import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import {
  activeSessionId,
  killSession,
  sessions,
  setActiveSession,
  spawnSession,
  type SessionMeta,
} from "../stores/sessions";

interface SessionsSheetProps {
  onClose: () => void;
}

export function SessionsSheet(props: SessionsSheetProps) {
  const [spawning, setSpawning] = createSignal(false);
  const [spawnError, setSpawnError] = createSignal<string | null>(null);

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  async function handleNewSession() {
    setSpawnError(null);
    setSpawning(true);
    try {
      await spawnSession();
      props.onClose();
    } catch (err) {
      setSpawnError(err instanceof Error ? err.message : String(err));
    } finally {
      setSpawning(false);
    }
  }

  function handleSelect(session: SessionMeta) {
    setActiveSession(session.sessionId);
    props.onClose();
  }

  return (
    <div
      class="fixed inset-0 z-50 flex flex-col justify-end bg-black/60"
      role="dialog"
      aria-modal="true"
      aria-label="Sessions"
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div
        class="flex max-h-[80vh] flex-col overflow-hidden rounded-t-2xl border-t border-neutral-800 bg-neutral-950 shadow-2xl"
        style={{
          "padding-bottom": "env(safe-area-inset-bottom)",
        }}
      >
        <div class="flex items-center justify-center pt-2.5 pb-1">
          <span class="h-1 w-10 rounded-full bg-neutral-700" aria-hidden="true" />
        </div>
        <div class="flex items-center justify-between px-4 pb-2">
          <h2 class="text-sm font-semibold tracking-tight">Sessions</h2>
          <button
            type="button"
            onClick={props.onClose}
            class="min-h-[44px] px-2 text-xs text-neutral-400 hover:text-neutral-200"
            aria-label="Close sessions"
          >
            Close
          </button>
        </div>

        <div class="border-t border-neutral-800">
          <button
            type="button"
            onClick={handleNewSession}
            disabled={spawning()}
            class="flex w-full min-h-[56px] items-center gap-3 px-4 text-left text-cyan-400 disabled:opacity-60"
          >
            <span
              class="flex h-7 w-7 items-center justify-center rounded-full border border-cyan-400/40 bg-cyan-400/10 text-base font-medium"
              aria-hidden="true"
            >
              +
            </span>
            <span class="flex-1 text-sm font-medium">
              {spawning() ? "Starting…" : "New session"}
            </span>
          </button>
          <Show when={spawnError()}>
            <p class="px-4 pb-2 text-xs text-red-400">{spawnError()}</p>
          </Show>
        </div>

        <ul class="flex-1 divide-y divide-neutral-900 overflow-y-auto border-t border-neutral-800">
          <Show
            when={sessions().length > 0}
            fallback={
              <li class="px-4 py-6 text-center text-xs text-neutral-500">
                No active sessions. Tap "New session" to spawn one.
              </li>
            }
          >
            <For each={sessions()}>
              {(session) => (
                <SessionRow
                  session={session}
                  isActive={session.sessionId === activeSessionId()}
                  onSelect={handleSelect}
                />
              )}
            </For>
          </Show>
        </ul>
      </div>
    </div>
  );
}

interface SessionRowProps {
  session: SessionMeta;
  isActive: boolean;
  onSelect: (session: SessionMeta) => void;
}

const KILL_THRESHOLD = 88; // px of leftward drag that commits the kill
const SWIPE_REVEAL = 96; // px the row settles at while the action is visible
const TAP_SLOP = 6; // px of movement still treated as a tap

function SessionRow(props: SessionRowProps) {
  const [offset, setOffset] = createSignal(0);
  const [killing, setKilling] = createSignal(false);
  let startX = 0;
  let startY = 0;
  let pointerId = 0;
  let dragging = false;
  let resolved = false;

  function onPointerDown(e: PointerEvent) {
    // Only react to primary pointer; right-clicks/multi-touch are skipped.
    if (e.button !== 0 && e.pointerType === "mouse") return;
    pointerId = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
    dragging = false;
    resolved = false;
    (e.currentTarget as HTMLElement).setPointerCapture(pointerId);
  }

  function onPointerMove(e: PointerEvent) {
    if (e.pointerId !== pointerId) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!dragging) {
      // Vertical intent wins — let the parent list scroll instead of
      // claiming the gesture.
      if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > TAP_SLOP) {
        resolved = true;
        return;
      }
      if (Math.abs(dx) > TAP_SLOP) {
        dragging = true;
      } else {
        return;
      }
    }
    // Only allow leftward drag; clamp so the row can't overshoot.
    const clamped = Math.max(Math.min(dx, 0), -SWIPE_REVEAL - 16);
    setOffset(clamped);
  }

  async function onPointerUp(e: PointerEvent) {
    if (e.pointerId !== pointerId) return;
    const wasDragging = dragging;
    const finalOffset = offset();
    dragging = false;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(pointerId);
    } catch {
      // releasePointerCapture throws if the capture was already lost — ignore.
    }

    if (!wasDragging && !resolved) {
      // Tap.
      setOffset(0);
      props.onSelect(props.session);
      return;
    }

    if (finalOffset <= -KILL_THRESHOLD) {
      // Animate out, then kill.
      setOffset(-window.innerWidth);
      setKilling(true);
      try {
        await killSession(props.session.sessionId);
      } catch {
        // The store removes the row optimistically; on failure we leave
        // the animation as-is. The user can retry from the list.
        setKilling(false);
        setOffset(0);
      }
      return;
    }

    // Below threshold — snap back to closed.
    setOffset(0);
  }

  function onPointerCancel(e: PointerEvent) {
    if (e.pointerId !== pointerId) return;
    dragging = false;
    setOffset(0);
  }

  return (
    <li class="relative overflow-hidden">
      {/* Destructive action revealed underneath the row. */}
      <div
        class="absolute inset-y-0 right-0 flex w-24 items-center justify-center bg-red-600 text-xs font-semibold uppercase tracking-wide text-white"
        aria-hidden="true"
      >
        {killing() ? "Killing…" : "Kill"}
      </div>
      <button
        type="button"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        class="relative flex w-full min-h-[56px] items-center gap-3 bg-neutral-950 px-4 py-2 text-left transition-transform touch-pan-y"
        style={{
          transform: `translateX(${offset()}px)`,
          transition:
            offset() === 0 || offset() <= -window.innerWidth ? "transform 180ms ease" : "none",
        }}
        aria-current={props.isActive ? "true" : undefined}
        aria-label={`Session ${props.session.label}, ${props.session.cli}`}
      >
        <span
          class={`size-2 rounded-full ${props.isActive ? "bg-cyan-400" : "bg-neutral-600"}`}
          aria-hidden="true"
        />
        <div class="flex min-w-0 flex-1 flex-col">
          <span class="truncate text-sm font-medium text-neutral-100">{props.session.label}</span>
          <Show when={props.session.cwd}>
            <span class="truncate font-mono text-[11px] text-neutral-500">{props.session.cwd}</span>
          </Show>
        </div>
        <span class="rounded-full border border-neutral-700 bg-neutral-900 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide text-neutral-300">
          {props.session.cli}
        </span>
      </button>
    </li>
  );
}
