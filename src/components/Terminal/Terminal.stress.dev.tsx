import { Show, createSignal, onCleanup, onMount } from "solid-js";
import { Terminal } from "./Terminal";

const TOTAL_CYCLES = 100;
const CYCLE_INTERVAL_MS = 60;

interface MemorySample {
  cycle: number;
  usedJsHeapMb: number | null;
}

const sampleHeapMb = (): number | null => {
  const perf = performance as Performance & {
    memory?: { usedJSHeapSize: number };
  };
  const used = perf.memory?.usedJSHeapSize;
  return typeof used === "number" ? Number((used / 1024 / 1024).toFixed(2)) : null;
};

export function TerminalStressHarness() {
  const [cycle, setCycle] = createSignal(0);
  const [mounted, setMounted] = createSignal(true);
  const [samples, setSamples] = createSignal<MemorySample[]>([]);
  const [done, setDone] = createSignal(false);

  let timer: number | null = null;

  onMount(() => {
    setSamples([{ cycle: 0, usedJsHeapMb: sampleHeapMb() }]);

    timer = window.setInterval(() => {
      setMounted((m) => {
        const nextMounted = !m;
        if (nextMounted) {
          setCycle((c) => {
            const nextCycle = c + 1;
            if (nextCycle % 10 === 0 || nextCycle === TOTAL_CYCLES) {
              setSamples((prev) => [...prev, { cycle: nextCycle, usedJsHeapMb: sampleHeapMb() }]);
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
          Mount/unmount loop. Memory samples (used JS heap, MB) every 10 cycles:
        </div>
        <pre class="mt-1 max-h-24 overflow-auto font-mono text-xs text-fg-tertiary">
          {samples()
            .map((s) => `#${s.cycle.toString().padStart(3, " ")}  ${s.usedJsHeapMb ?? "n/a"}`)
            .join("\n")}
        </pre>
      </div>
      <div class="min-h-0 overflow-hidden rounded-md border border-border-default">
        <Show when={mounted()}>
          <Terminal sessionId={`stress-${cycle()}`} />
        </Show>
      </div>
    </div>
  );
}

export default TerminalStressHarness;
