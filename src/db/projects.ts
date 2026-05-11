// T3.6: typed wrappers around the project CRUD Tauri commands.
//
// The Rust side (`src-tauri/src/commands/projects.rs`) returns project rows
// in camelCase (serde `rename_all = "camelCase"`). We re-validate the wire
// payload with Zod here so a backend drift doesn't silently land in stores
// or UI components — same pattern as `parseLayout` in `db/sessions.ts`.

import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";

import {
  DEFAULT_ACTIVE_TAB,
  DEFAULT_VISIBLE_TABS,
  WORKSPACE_TAB_KINDS,
  type WorkspaceTabKind,
} from "../types/workspaceTab";

export const ProjectEnvSchema = z.record(z.string(), z.string());
export type ProjectEnv = z.infer<typeof ProjectEnvSchema>;

export const ProjectStartupCommandsSchema = z.array(z.string());
export type ProjectStartupCommands = z.infer<typeof ProjectStartupCommandsSchema>;

const WorkspaceTabKindLoose = z.string().transform((value, ctx): WorkspaceTabKind => {
  if ((WORKSPACE_TAB_KINDS as readonly string[]).includes(value)) {
    return value as WorkspaceTabKind;
  }
  ctx.addIssue({ code: z.ZodIssueCode.custom, message: `unknown tab kind: ${value}` });
  return z.NEVER;
});

const ProjectWorkspaceTabsSchema = z
  .array(WorkspaceTabKindLoose)
  .optional()
  .transform((kinds): WorkspaceTabKind[] => {
    if (!kinds || kinds.length === 0) return [...DEFAULT_VISIBLE_TABS];
    const seen = new Set<WorkspaceTabKind>();
    const out: WorkspaceTabKind[] = [];
    for (const k of kinds) {
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(k);
    }
    if (!seen.has("terminal")) out.unshift("terminal");
    return out;
  });

const ActiveWorkspaceTabSchema = z
  .string()
  .optional()
  .transform((value): WorkspaceTabKind => {
    if (!value) return DEFAULT_ACTIVE_TAB;
    return (WORKSPACE_TAB_KINDS as readonly string[]).includes(value)
      ? (value as WorkspaceTabKind)
      : DEFAULT_ACTIVE_TAB;
  });

export const ProjectSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  path: z.string(),
  color: z
    .string()
    .nullable()
    .optional()
    .transform((v) => v ?? null),
  icon: z
    .string()
    .nullable()
    .optional()
    .transform((v) => v ?? null),
  defaultCli: z
    .string()
    .nullable()
    .optional()
    .transform((v) => v ?? null),
  env: ProjectEnvSchema,
  startupCommands: ProjectStartupCommandsSchema,
  workspaceTabs: ProjectWorkspaceTabsSchema,
  activeWorkspaceTab: ActiveWorkspaceTabSchema,
  position: z.number().int(),
  createdAt: z.number().int(),
});
export type Project = z.infer<typeof ProjectSchema>;

const ProjectListSchema = z.array(ProjectSchema);

export interface CreateProjectInput {
  name: string;
  path: string;
  color?: string | null;
  icon?: string | null;
  defaultCli?: string | null;
  env?: ProjectEnv;
  startupCommands?: ProjectStartupCommands;
}

export interface UpdateProjectInput {
  id: string;
  name: string;
  path: string;
  color?: string | null;
  icon?: string | null;
  defaultCli?: string | null;
  env?: ProjectEnv;
  startupCommands?: ProjectStartupCommands;
}

export async function listProjects(): Promise<Project[]> {
  const raw = await invoke<unknown>("project_list");
  return ProjectListSchema.parse(raw);
}

export async function createProject(input: CreateProjectInput): Promise<Project> {
  const raw = await invoke<unknown>("project_create", { args: toArgs(input) });
  return ProjectSchema.parse(raw);
}

export async function updateProject(input: UpdateProjectInput): Promise<Project> {
  const raw = await invoke<unknown>("project_update", { args: toArgs(input) });
  return ProjectSchema.parse(raw);
}

export async function deleteProject(id: string): Promise<void> {
  await invoke("project_delete", { args: { id } });
}

/** T6.7: persist a new sidebar order. `ids` must list every project exactly
 *  once — the backend reassigns `position = idx` inside a single SQLite
 *  transaction. */
export async function reorderProjects(ids: string[]): Promise<void> {
  await invoke("project_reorder", { args: { ids } });
}

/** T11.1: persist a project's workspace tab state (visible list + active
 *  tab). The caller debounces — bursts of clicks coalesce into one
 *  round-trip — so this wrapper is intentionally fire-and-forget shaped:
 *  the backend returns void on success and a `ProjectCommandError` on
 *  failure (e.g. NotFound when the project was deleted concurrently). */
export async function updateProjectWorkspaceTabs(
  id: string,
  visible: WorkspaceTabKind[],
  active: WorkspaceTabKind,
): Promise<void> {
  await invoke("project_update_workspace_tabs", {
    args: { id, visible, active },
  });
}

// Normalize undefined → null so the Rust side sees a consistent shape.
// `env` and `startupCommands` default to empty so the backend never has to
// special-case missing.
function toArgs<T extends CreateProjectInput | UpdateProjectInput>(input: T): T {
  return {
    ...input,
    color: input.color ?? null,
    icon: input.icon ?? null,
    defaultCli: input.defaultCli ?? null,
    env: input.env ?? {},
    startupCommands: input.startupCommands ?? [],
  };
}
