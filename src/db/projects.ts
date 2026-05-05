// T3.6: typed wrappers around the project CRUD Tauri commands.
//
// The Rust side (`src-tauri/src/commands/projects.rs`) returns project rows
// in camelCase (serde `rename_all = "camelCase"`). We re-validate the wire
// payload with Zod here so a backend drift doesn't silently land in stores
// or UI components — same pattern as `parseLayout` in `db/sessions.ts`.

import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";

export const ProjectEnvSchema = z.record(z.string(), z.string());
export type ProjectEnv = z.infer<typeof ProjectEnvSchema>;

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
}

export interface UpdateProjectInput {
  id: string;
  name: string;
  path: string;
  color?: string | null;
  icon?: string | null;
  defaultCli?: string | null;
  env?: ProjectEnv;
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

// Normalize undefined → null so the Rust side sees a consistent shape.
// `env` defaults to {} so the backend never has to special-case missing.
function toArgs<T extends CreateProjectInput | UpdateProjectInput>(input: T): T {
  return {
    ...input,
    color: input.color ?? null,
    icon: input.icon ?? null,
    defaultCli: input.defaultCli ?? null,
    env: input.env ?? {},
  };
}
