// T6.8: ProjectsEmptyState harness — renders the onboarding card on its
// own and wires the CTA to a real `AddProjectModal` so the create flow can
// be exercised end-to-end without first deleting every demo project from
// the database.
//
// Reachable via `?wsdebug=projectsempty` in dev builds.

import { createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { AddProjectModal } from "../AddProjectModal";
import type { AddProjectFormValue } from "../AddProjectModal";
import { ProjectsEmptyState } from "./ProjectsEmptyState";
import { createProject } from "../../db/projects";
import { pickProjectFolder } from "../../ipc/picker";

export function ProjectsEmptyStateLiveHarness(): JSX.Element {
  const [addOpen, setAddOpen] = createSignal(false);
  const [lastCreated, setLastCreated] = createSignal<string | null>(null);

  const handleCreate = async (value: AddProjectFormValue): Promise<void> => {
    const created = await createProject({
      name: value.name,
      path: value.path,
      color: value.color,
      icon: value.glyph,
    });
    setLastCreated(created.name);
  };

  return (
    <div class="grid h-full w-full grid-rows-[auto_1fr] gap-2 bg-canvas p-3 text-fg">
      <div class="rounded-md border border-border-default bg-surface p-2 text-xs">
        <div class="font-semibold">ProjectsEmptyState harness (T6.8)</div>
        <div class="mt-1 text-fg-secondary">
          Press the CTA — the Add Project modal should open. Submitting it persists a real row via
          `createProject`. The empty state itself doesn't unmount; you'll need to refresh into
          `?wsdebug=appshell` to see the project appear.
        </div>
        {lastCreated() ? (
          <div class="mt-2 rounded border border-accent/40 bg-accent/10 px-2 py-1 text-fg">
            Created project: <span class="font-mono">{lastCreated()}</span>
          </div>
        ) : null}
      </div>
      <div class="min-h-0 overflow-hidden rounded-md border border-border-default">
        <ProjectsEmptyState onAddProject={() => setAddOpen(true)} shortcut="⌘N" />
      </div>
      <AddProjectModal
        open={addOpen()}
        onClose={() => setAddOpen(false)}
        onPickFolder={pickProjectFolder}
        onSubmit={handleCreate}
      />
    </div>
  );
}

export default ProjectsEmptyStateLiveHarness;
