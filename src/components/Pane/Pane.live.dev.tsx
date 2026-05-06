// T5.5: Pane focus harness — exercises the focus contract without
// touching the PTY layer.
//
//   • Three placeholder panes laid out side-by-side.
//   • Click any pane → that one shows the accent ring; the others lose it.
//   • Tab/Shift-Tab through the in-pane buttons → focusin bubbles up to
//     the wrapper, so keyboard nav also drives the focused state.
//   • A counter on each pane increments on every onFocus call so we can
//     verify activations are debounced (idempotent) by the parent.
//
// Reachable via `?wsdebug=pane` in dev builds.

import { For, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { Pane } from "./Pane";

interface DemoPane {
  id: string;
  label: string;
}

const DEMO_PANES: DemoPane[] = [
  { id: "demo-pane-a", label: "Pane A" },
  { id: "demo-pane-b", label: "Pane B" },
  { id: "demo-pane-c", label: "Pane C" },
];

export function PaneLiveHarness(): JSX.Element {
  const [focused, setFocused] = createSignal<string>(DEMO_PANES[0]?.id ?? "");
  const [activations, setActivations] = createSignal<Record<string, number>>({});

  const handleFocus = (id: string): void => {
    setFocused(id);
    setActivations((prev) => ({ ...prev, [id]: (prev[id] ?? 0) + 1 }));
  };

  return (
    <div class="grid h-full w-full grid-rows-[auto_1fr] gap-2 bg-canvas p-3 text-fg">
      <div class="rounded-md border border-border-default bg-surface p-2 text-xs">
        <div class="font-semibold">Pane harness (T5.5)</div>
        <div class="mt-1 text-fg-secondary">
          Click a pane to focus it. The accent ring should snap to the clicked pane and stay there —
          keyboard tabbing inside a pane also activates it (focusin bubbles).
        </div>
      </div>
      <div class="grid min-h-0 grid-cols-3 gap-2">
        <For each={DEMO_PANES}>
          {(p) => (
            <Pane sessionId={p.id} focused={focused() === p.id} onFocus={handleFocus}>
              <div class="grid h-full grid-rows-[auto_1fr_auto] gap-2 p-3 text-xs">
                <div class="font-semibold">{p.label}</div>
                <div class="rounded bg-bg-active p-2 font-mono text-[11px] text-fg-secondary">
                  sessionId: <span class="text-fg">{p.id}</span>
                  <br />
                  focused: <span class="text-fg">{focused() === p.id ? "yes" : "no"}</span>
                  <br />
                  onFocus calls: <span class="text-fg">{activations()[p.id] ?? 0}</span>
                </div>
                <div class="flex flex-wrap gap-2">
                  <button
                    type="button"
                    class="rounded border border-border-default px-2 py-1 hover:bg-bg-hover"
                  >
                    button 1
                  </button>
                  <button
                    type="button"
                    class="rounded border border-border-default px-2 py-1 hover:bg-bg-hover"
                  >
                    button 2
                  </button>
                </div>
              </div>
            </Pane>
          )}
        </For>
      </div>
    </div>
  );
}

export default PaneLiveHarness;
