// T6.1: Sidebar harness — exercises rendering, active highlight, and the
// collapse animation without touching the project store (T6.2 wires that
// up). Uses the swatch-* design tokens so the icons stay theme-aware.
//
// Reachable via `?wsdebug=sidebar` in dev builds.

import { createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { Sidebar } from "./Sidebar";
import type { SidebarProject } from "./Sidebar";

const DEMO_PROJECTS: SidebarProject[] = [
  { id: "argon", name: "argon-web", glyph: "AR", color: "var(--swatch-4)", sessions: 4 },
  { id: "kepler", name: "kepler-cli", glyph: "KE", color: "var(--swatch-6)", sessions: 2 },
  { id: "borealis", name: "borealis-api", glyph: "BO", color: "var(--swatch-3)", sessions: 1 },
  { id: "nimbus", name: "nimbus-infra", glyph: "NI", color: "var(--swatch-5)", sessions: 0 },
  { id: "polaris", name: "polaris-design", glyph: "PO", color: "var(--swatch-8)", sessions: 0 },
  { id: "vega", name: "vega-mobile", glyph: "VE", color: "var(--swatch-7)", sessions: 0 },
];

export function SidebarLiveHarness(): JSX.Element {
  const [activeId, setActiveId] = createSignal<string>("argon");
  const [collapsed, setCollapsed] = createSignal(false);
  const [lastEvent, setLastEvent] = createSignal<string>("—");

  return (
    <div class="grid h-full w-full grid-cols-[1fr_auto] bg-canvas text-fg">
      <div class="flex min-h-0 flex-col gap-3 p-4">
        <div class="rounded-md border border-border-default bg-surface p-3 text-xs">
          <div class="font-semibold">Sidebar harness (T6.1)</div>
          <div class="mt-1 text-fg-secondary">
            Click a project to activate it; the accent rail snaps to the active row. Use the chevron
            in the section header to collapse/expand the sidebar — the rail keeps its glyph + a
            corner dot for running sessions.
          </div>
        </div>
        <div class="rounded-md border border-border-default bg-surface p-3 font-mono text-[11px] text-fg-secondary">
          <div>
            active: <span class="text-fg">{activeId()}</span>
          </div>
          <div>
            collapsed: <span class="text-fg">{collapsed() ? "yes" : "no"}</span>
          </div>
          <div>
            lastEvent: <span class="text-fg">{lastEvent()}</span>
          </div>
        </div>
      </div>
      <Sidebar
        projects={DEMO_PROJECTS}
        activeId={activeId()}
        collapsed={collapsed()}
        newProjectShortcut="⌘N"
        onActivate={(id) => {
          setActiveId(id);
          setLastEvent(`activate(${id})`);
        }}
        onAdd={() => setLastEvent("add")}
        onSettings={() => setLastEvent("settings")}
        onToggleCollapse={() => {
          setCollapsed((c) => !c);
          setLastEvent("toggleCollapse");
        }}
      />
    </div>
  );
}

export default SidebarLiveHarness;
