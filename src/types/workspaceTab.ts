// T11.1: project workspace tab kinds.
//
// A project workspace is no longer just a terminal layout — it gains a
// horizontal tab strip that flips the visible body between Terminal,
// Editor, and per-integration views (PlanFlow, GitHub, Vercel, Neon,
// Railway). The non-terminal tabs land in later phases (T12.x–T17.x);
// until then they render a "connect via Settings → Integrations" stub.
//
// Tab visibility is per-project, so a project that has only linked
// GitHub doesn't see Vercel/Neon/Railway in its strip. The Terminal tab
// is always visible — closing the terminal pane drops the pane, not the
// tab itself. Active tab persists across launches.

import { z } from "zod";

export const WORKSPACE_TAB_KINDS = [
  "terminal",
  "editor",
  "planflow",
  "github",
  "vercel",
  "neon",
  "railway",
] as const;

export type WorkspaceTabKind = (typeof WORKSPACE_TAB_KINDS)[number];

export const WorkspaceTabKindSchema = z.enum(WORKSPACE_TAB_KINDS);

/** Static metadata for each kind. Labels are user-facing; integration kinds
 *  share a generic "integration" category that drives the placeholder copy. */
export interface WorkspaceTabMeta {
  kind: WorkspaceTabKind;
  label: string;
  /** `core` tabs (Terminal, Editor) ship with the app and are always
   *  available. `integration` tabs require a linked service (T11.5) to
   *  show useful content; until then they render the integration stub. */
  category: "core" | "integration";
}

export const WORKSPACE_TAB_META: Readonly<Record<WorkspaceTabKind, WorkspaceTabMeta>> = {
  terminal: { kind: "terminal", label: "Terminal", category: "core" },
  editor: { kind: "editor", label: "Editor", category: "core" },
  planflow: { kind: "planflow", label: "PlanFlow", category: "integration" },
  github: { kind: "github", label: "GitHub", category: "integration" },
  vercel: { kind: "vercel", label: "Vercel", category: "integration" },
  neon: { kind: "neon", label: "Neon", category: "integration" },
  railway: { kind: "railway", label: "Railway", category: "integration" },
};

/** Terminal + Editor are the core tabs and ship visible by default.
 *  Editor mounts a Monaco instance (T13.1) so the user can scratch-edit
 *  before file open lands in T13.3. Integration tabs surface only after
 *  the matching service is linked (T11.5). */
export const DEFAULT_VISIBLE_TABS: readonly WorkspaceTabKind[] = ["terminal", "editor"];

export const DEFAULT_ACTIVE_TAB: WorkspaceTabKind = "terminal";

/** Schema for the per-project visible-tabs list as stored in SQLite
 *  (`projects.workspace_tabs_json`). Duplicates and unknown values are
 *  dropped so a corrupt row degrades to the default tab set instead of
 *  crashing the boot path. */
export const WorkspaceTabsSchema = z.array(WorkspaceTabKindSchema).transform((kinds) => {
  const seen = new Set<WorkspaceTabKind>();
  const out: WorkspaceTabKind[] = [];
  for (const kind of kinds) {
    if (seen.has(kind)) continue;
    seen.add(kind);
    out.push(kind);
  }
  // Terminal + Editor are always visible — rows that somehow lost them get
  // them back. Terminal stays first; Editor slots in right after.
  if (!seen.has("terminal")) {
    out.unshift("terminal");
    seen.add("terminal");
  }
  if (!seen.has("editor")) {
    const terminalIdx = out.indexOf("terminal");
    out.splice(terminalIdx + 1, 0, "editor");
  }
  return out;
});

/** Parse a workspace_tabs_json blob. Returns the default set when input is
 *  null/undefined/invalid JSON. */
export function parseWorkspaceTabsJson(raw: string | null | undefined): WorkspaceTabKind[] {
  if (!raw) return [...DEFAULT_VISIBLE_TABS];
  try {
    const parsed: unknown = JSON.parse(raw);
    const result = WorkspaceTabsSchema.safeParse(parsed);
    if (!result.success) return [...DEFAULT_VISIBLE_TABS];
    return result.data;
  } catch {
    return [...DEFAULT_VISIBLE_TABS];
  }
}

/** Parse a stored active-tab string. Falls back to the default when the
 *  value isn't a known kind. */
export function parseActiveWorkspaceTab(raw: string | null | undefined): WorkspaceTabKind {
  if (!raw) return DEFAULT_ACTIVE_TAB;
  const result = WorkspaceTabKindSchema.safeParse(raw);
  return result.success ? result.data : DEFAULT_ACTIVE_TAB;
}
