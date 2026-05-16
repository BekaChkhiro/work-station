// T11.5: typed wrappers around the project_link Tauri commands.
// T19.33: writes route through `routeIpc` so cloud-mode hits the
// cloud-agent's `project_link_*` WS handlers (T19.32).
//
// The Rust side returns rows with serde `rename_all = "camelCase"` — same
// pattern as `db/projects.ts`. We re-validate on the wire with Zod so a
// backend drift (local or cloud) doesn't silently leak into UI stores.
// `metadata` is kept as `Record<string, unknown>` here; each integration
// (T14.x / T15.x / etc.) narrows it to its own Zod schema at the call
// site.

import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";

import { Integration, type IntegrationId } from "../integrations/credentials";
import { routeIpc } from "../ipc/transport";

export const ProjectLinkMetadataSchema = z.record(z.string(), z.unknown());
export type ProjectLinkMetadata = z.infer<typeof ProjectLinkMetadataSchema>;

export const ProjectLinkSchema = z.object({
  projectId: z.string().min(1),
  service: z.string().min(1),
  externalId: z.string().min(1),
  metadata: ProjectLinkMetadataSchema,
  createdAt: z.number().int(),
});
export type ProjectLink = z.infer<typeof ProjectLinkSchema>;

const ProjectLinkListSchema = z.array(ProjectLinkSchema);

export interface SetProjectLinkInput {
  projectId: string;
  service: IntegrationId | string;
  externalId: string;
  metadata?: ProjectLinkMetadata;
}

export async function listProjectLinks(projectId: string): Promise<ProjectLink[]> {
  return routeIpc(
    async () => {
      const raw = await invoke<unknown>("project_link_list", { args: { projectId } });
      return ProjectLinkListSchema.parse(raw);
    },
    async (client) => {
      const raw = await client.projectLinkList(projectId);
      return ProjectLinkListSchema.parse(raw);
    },
  );
}

export async function setProjectLink(input: SetProjectLinkInput): Promise<ProjectLink> {
  const metadata = input.metadata ?? {};
  return routeIpc(
    async () => {
      const raw = await invoke<unknown>("project_link_set", {
        args: {
          projectId: input.projectId,
          service: input.service,
          externalId: input.externalId,
          metadata,
        },
      });
      return ProjectLinkSchema.parse(raw);
    },
    async (client) => {
      const raw = await client.projectLinkSet({
        projectId: input.projectId,
        service: input.service,
        externalId: input.externalId,
        metadata,
      });
      return ProjectLinkSchema.parse(raw);
    },
  );
}

export async function deleteProjectLink(
  projectId: string,
  service: IntegrationId | string,
  externalId: string,
): Promise<boolean> {
  return routeIpc(
    async () =>
      invoke<boolean>("project_link_delete", {
        args: { projectId, service, externalId },
      }),
    async (client) => client.projectLinkDelete(projectId, service, externalId),
  );
}

/** Re-export so call sites that build links don't need a second import. */
export { Integration };
export type { IntegrationId };
