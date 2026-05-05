// Dev-only mount/unmount stress harness for the Terminal component (T4.2).
//
// Reachable via `?wsdebug=terminal-stress`. Cycles `<Terminal />` 100 times
// at 60ms, sampling JS heap usage every 10 cycles.
//
// Important caveats — read before drawing conclusions from the numbers:
//
//   1. `performance.memory.usedJSHeapSize` is Chrome / V8 only. WebKit
//      (Tauri's macOS WebView) and Firefox return undefined here. The
//      harness shows "n/a" in those engines, which is accurate — there's
//      no leak signal at all.
//
//   2. V8 garbage-collects lazily. Without forcing a GC immediately before
//      sampling, the heap reading is whatever V8 happens to be holding,
//      not the true retained set. The harness calls `window.gc()` before
//      each sample; that function only exists when Chrome is launched
//      with `--js-flags="--expose-gc"`. In a stock Tauri / browser run
//      `gc()` is undefined and we sample with a stale heap.
//
//   3. A 100-cycle smoke test catches gross leaks (unsubscribed listeners,
//      addons not disposed, retained DOM trees) but won't detect
//      slow-drift leaks. For those, run with `--expose-gc`, raise
//      TOTAL_CYCLES to a few thousand, and watch the deltas trend rather
//      than absolute values.
//
// The metric the harness shows alongside raw heap is the delta from the
// cycle-1 baseline — a rising delta after 100 cycles is the actual signal
// to investigate, not the absolute MB number.

import { Show, createSignal, onCleanup, onMount } from "solid-js";
import { Terminal } from "./Terminal";

const TOTAL_CYCLES = 100;
const CYCLE_INTERVAL_MS = 60;

interface MemorySample {
  cycle: number;
  usedJsHeapMb: number | null;
  /** MB delta vs cycle-1 baseline. null when baseline or sample is n/a. */
  deltaMb: number | null;
}

// Best-effort GC trigger. Only available when the runtime is launched with
// `--js-flags="--expose-gc"` (Chrome / Node debug builds); in production
// browsers this is undefined and the call is a no-op.
const requestGc = (): void => {
  const w = window as Window & { gc?: () => void };
  try {
    w.gc?.();
  } catch {
    /* ignore — gc() can throw in some debug configurations. */
  }
};

const sampleHeapMb = (): number | null => {
  requestGc();
  const perf = performance as Performance & {
    memory?: { usedJSHeapSize: number };
  };
  const used = perf.memory?.usedJSHeapSize;
  return typeof used === "number" ? Number((used / 1024 / 1024).toFixed(2)) : null;
};

const hasGcExposed = (): boolean =>
  typeof window !== "undefined" && typeof (window as { gc?: unknown }).gc === "function";

const hasMemoryApi = (): boolean =>
  typeof performance !== "undefined" &&
  typeof (performance as { memory?: unknown }).memory === "object";

const formatDelta = (delta: number | null): string => {
  if (delta === null) return "    -";
  const sign = delta > 0 ? "+" : delta < 0 ? "" : " ";
  return `${sign}${delta.toFixed(2)}`;
};

export function TerminalStressHarness() {
  const [cycle, setCycle] = createSignal(0);
  const [mounted, setMounted] = createSignal(true);
  const [samples, setSamples] = createSignal<MemorySample[]>([]);
  const [done, setDone] = createSignal(false);

  let timer: number | null = null;
  let baselineMb: number | null = null;

  const recordSample = (cycleNumber: number): void => {
    const used = sampleHeapMb();
    if (baselineMb === null) baselineMb = used;
    const delta =
      used !== null && baselineMb !== null ? Number((used - baselineMb).toFixed(2)) : null;
    setSamples((prev) => [...prev, { cycle: cycleNumber, usedJsHeapMb: used, deltaMb: delta }]);
  };

  onMount(() => {
    recordSample(0);

    timer = window.setInterval(() => {
      setMounted((m) => {
        const nextMounted = !m;
        if (nextMounted) {
          setCycle((c) => {
            const nextCycle = c + 1;
            if (nextCycle % 10 === 0 || nextCycle === TOTAL_CYCLES) {
              recordSample(nextCycle);
            }
            if (nextCycle >= TOTAL_CYCLES) {
              setDone(true);
              if (timer !== null) {
                clearInterval(timer);
                timer = null;
              }
            }
            return nextCycle;
          });
        }
        return nextMounted;
      });
    }, CYCLE_INTERVAL_MS);
  });

  onCleanup(() => {
    if (timer !== null) clearInterval(timer);
  });

  return (
    <div class="grid h-full w-full grid-rows-[auto_1fr] gap-2 bg-canvas p-3 text-fg">
      <div class="rounded-md border border-border-default bg-surface p-2 text-xs">
        <div class="font-semibold">
          Terminal stress harness — cycle {cycle()} / {TOTAL_CYCLES}
          <Show when={done()}>
            <span class="ml-2 text-success">DONE</span>
          </Show>
        </div>
        <div class="mt-1 text-fg-secondary">
          Mount / unmount loop. Δ shows MB delta from the cycle-0 baseline — that's the signal worth
          watching, not the absolute heap number.
        </div>
        <Show when={!hasMemoryApi()}>
          <div class="mt-1 text-warning">
            <code class="font-mono">performance.memory</code> unavailable in this engine — samples
            will be "n/a". Run in Chrome / Chromium-based WebView to see numbers.
          </div>
        </Show>
        <Show when={hasMemoryApi() && !hasGcExposed()}>
          <div class="mt-1 text-warning">
            GC not exposed — heap readings reflect V8's lazy collection state, not the true retained
            set. For a reliable signal, launch with{" "}
            <code class="font-mono">--js-flags=&quot;--expose-gc&quot;</code>.
          </div>
        </Show>
        <pre class="mt-1 max-h-32 overflow-auto font-mono text-xs text-fg-tertiary">
          {`cycle    heap MB   Δ MB\n` +
            samples()
              .map(
                (s) =>
                  `#${s.cycle.toString().padStart(3, " ")}    ${(s.usedJsHeapMb ?? "n/a").toString().padStart(7, " ")}   ${formatDelta(s.deltaMb)}`,
              )
              .join("\n")}
        </pre>
      </div>
      <div class="min-h-0 overflow-hidden rounded-md border border-border-default">
        <Show when={mounted()}>
          <Terminal sessionId={`stress-${cycle()}`} autoSubscribe={false} />
        </Show>
      </div>
    </div>
  );
}

export default TerminalStressHarness;
