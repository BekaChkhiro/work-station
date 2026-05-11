// T11.7 — Visual harness for the async-state primitives.
//
// Cycle through the four slots side-by-side with the actual chrome so the
// shimmer, pulse, empty card, and error card can be eyeballed against the
// design spec without spinning up a real integration view. Reachable via
// `?wsdebug=asyncstates` in dev builds.

import { For, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { EmptyState, ErrorCard, LoadingPulse, SkeletonRows } from "./index";

type Slot = "skeleton" | "pulse" | "empty-primary" | "empty-muted" | "error";

const SLOTS: { id: Slot; label: string }[] = [
  { id: "skeleton", label: "Skeleton" },
  { id: "pulse", label: "Pulse" },
  { id: "empty-primary", label: "Empty · primary" },
  { id: "empty-muted", label: "Empty · muted" },
  { id: "error", label: "Error" },
];

export function AsyncStatesLiveHarness(): JSX.Element {
  const [slot, setSlot] = createSignal<Slot>("skeleton");
  const [bumps, setBumps] = createSignal(0);

  return (
    <div class="grid h-full w-full grid-rows-[auto_1fr] gap-2 bg-canvas p-3 text-fg">
      <div class="flex flex-wrap items-center gap-2 rounded-md border border-border-default bg-surface p-2 text-xs">
        <div class="font-semibold">AsyncStates harness (T11.7)</div>
        <div class="text-fg-secondary">
          Validates skeleton shimmer, pulse dots, empty card (primary/muted variants), and error
          card with retry. All states must respect prefers-reduced-motion.
        </div>
        <div class="ml-auto flex gap-1">
          <For each={SLOTS}>
            {(opt) => (
              <button
                type="button"
                class="ws-settings-page__btn"
                data-on={slot() === opt.id ? "true" : undefined}
                onClick={() => setSlot(opt.id)}
              >
                {opt.label}
              </button>
            )}
          </For>
        </div>
      </div>

      <div class="ws-appshell__pane-host relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border-default bg-canvas">
        {slot() === "skeleton" ? <SkeletonRows rows={6} ariaLabel="Loading deployments" /> : null}
        {slot() === "pulse" ? <LoadingPulse block label="Spawning" /> : null}
        {slot() === "empty-primary" ? (
          <EmptyState
            title="No deployments yet"
            description="Trigger your first deploy from the terminal — Work Station will pick it up automatically."
            primaryAction={{ label: "Open docs", onClick: () => setBumps((n) => n + 1) }}
          />
        ) : null}
        {slot() === "empty-muted" ? (
          <EmptyState
            variant="muted"
            title="PlanFlow"
            description="Connect PlanFlow in Settings to use this view."
            primaryAction={{ label: "Open Settings", onClick: () => setBumps((n) => n + 1) }}
          />
        ) : null}
        {slot() === "error" ? (
          <ErrorCard
            title="Couldn't fetch deployments"
            message="Vercel rejected the request. Check that the token is still valid or pick a different project."
            detail="HTTP 401 · invalid_token"
            onRetry={() => setBumps((n) => n + 1)}
            secondary={{ label: "Open Settings", onClick: () => setBumps((n) => n + 1) }}
            helpLink={{ label: "View Vercel docs ↗", onClick: () => setBumps((n) => n + 1) }}
          />
        ) : null}
      </div>

      <div class="text-xs text-fg-tertiary">CTA clicks: {bumps()}</div>
    </div>
  );
}

export default AsyncStatesLiveHarness;
