// Dev-only harness: TabStrip with a synthetic project's tab list so the
// T5.3 acceptance can be exercised manually:
//
//   • Click a tab — it activates.
//   • Drag a tab past another's center — drop reorders.
//   • Click "+" — adds a new tab at the end with a rotating CLI.
//   • Click x on a clean tab — closes immediately.
//   • Click x on a dirty tab (•) — confirm dialog gates the close.
//
// Reachable via `?wsdebug=tabstrip` in dev builds. Lives outside the Tauri
// IPC boundary on purpose — TabStrip is presentational, no PTY needed.

import { createSignal } from "solid-js";
import { TabStrip } from "./TabStrip";
import type { CliMeta, Tab } from "../../types/tab";

const cliMap: Record<string, CliMeta> = {
  cc: { badge: "cc", color: "oklch(0.74 0.11 188)" },
  km: { badge: "km", color: "oklch(0.78 0.13 90)" },
  cx: { badge: "cx", color: "oklch(0.72 0.16 320)" },
  zsh: { badge: "zs" },
  bash: { badge: "ba" },
};

const cliRotation = ["cc", "km", "cx", "zsh", "bash"] as const;

const seedTabs: Tab[] = [
  { id: "t1", label: "claude code", cli: "cc", dirty: true },
  { id: "t2", label: "pnpm dev", cli: "km" },
  { id: "t3", label: "zsh ~/dev", cli: "zsh" },
  { id: "t4", label: "kimi review", cli: "km", dirty: true },
];

export function TabStripLiveHarness() {
  const [tabs, setTabs] = createSignal<Tab[]>(seedTabs);
  const [activeId, setActiveId] = createSignal<string | null>("t1");
  const [log, setLog] = createSignal<string[]>([]);

  const append = (msg: string): void => {
    setLog((prev) => [`${new Date().toLocaleTimeString()}  ${msg}`, ...prev].slice(0, 12));
  };

  const handleClose = (id: string): void => {
    const tab = tabs().find((t) => t.id === id);
    if (!tab) return;
    if (tab.dirty) {
      // T5.3 acceptance: "close confirms if process is running". Confirm
      // lives here in the parent because the strip is presentational.
      const ok = window.confirm(`${tab.label} has a running process. Close it anyway?`);
      if (!ok) {
        append(`close cancelled (${id})`);
        return;
      }
    }
    setTabs((prev) => prev.filter((t) => t.id !== id));
    if (activeId() === id) {
      const remaining = tabs().filter((t) => t.id !== id);
      setActiveId(remaining[0]?.id ?? null);
    }
    append(`closed ${id}`);
  };

  const handleAdd = (): void => {
    const next = nextId(tabs());
    const cli = cliRotation[tabs().length % cliRotation.length] ?? "zsh";
    const tab: Tab = { id: next, label: `pane ${next}`, cli };
    setTabs((prev) => [...prev, tab]);
    setActiveId(next);
    append(`added ${next}`);
  };

  const handleReorder = (next: Tab[]): void => {
    setTabs(next);
    append(`reordered → ${next.map((t) => t.id).join(",")}`);
  };

  const toggleDirty = (): void => {
    const id = activeId();
    if (!id) return;
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, dirty: !t.dirty } : t)));
  };

  return (
    <div class="grid h-full w-full grid-rows-[auto_auto_1fr] gap-2 bg-canvas p-3 text-fg">
      <div class="rounded-md border border-border-default bg-surface p-2 text-xs">
        <div class="font-semibold">TabStrip harness (T5.3)</div>
        <div class="mt-1 text-fg-secondary">
          Drag a tab past another's midpoint to reorder. Close on a dirty tab (•) prompts a confirm.
          Active tab id: <code class="font-mono">{activeId() ?? "—"}</code>
        </div>
        <div class="mt-2 flex gap-2">
          <button
            type="button"
            class="rounded border border-border-default px-2 py-1 hover:bg-bg-hover"
            onClick={toggleDirty}
            disabled={!activeId()}
          >
            Toggle dirty on active
          </button>
          <button
            type="button"
            class="rounded border border-border-default px-2 py-1 hover:bg-bg-hover"
            onClick={() => {
              setTabs(seedTabs);
              setActiveId("t1");
              append("reset to seed tabs");
            }}
          >
            Reset
          </button>
        </div>
      </div>
      <TabStrip
        tabs={tabs()}
        activeId={activeId()}
        cliMap={cliMap}
        onActivate={(id) => {
          setActiveId(id);
          append(`activated ${id}`);
        }}
        onClose={handleClose}
        onAdd={handleAdd}
        onReorder={handleReorder}
      />
      <div class="min-h-0 overflow-auto rounded-md border border-border-default bg-surface p-2 font-mono text-xs">
        <div class="mb-1 text-fg-secondary">Event log</div>
        {log().length === 0 ? (
          <div class="text-fg-tertiary">no events yet</div>
        ) : (
          log().map((line) => <div>{line}</div>)
        )}
      </div>
    </div>
  );
}

function nextId(tabs: Tab[]): string {
  const used = new Set(tabs.map((t) => t.id));
  for (let i = tabs.length + 1; i < tabs.length + 100; i++) {
    const candidate = `t${i}`;
    if (!used.has(candidate)) return candidate;
  }
  return `t${Date.now()}`;
}

export default TabStripLiveHarness;
