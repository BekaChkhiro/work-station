/**
 * Sidebar — right-side project navigation panel.
 *
 * Lists all projects with color/icon indicators and active highlighting.
 * Clicking a project selects it (highlight); actual layout switching is T6.2.
 * Each project has an edit button to open ProjectSettingsDialog.
 */

import { createSignal, For, Show, onMount } from "solid-js";
import {
  activeProjectId,
  getProjects,
  isProjectsLoading,
  loadProjects,
  selectProject,
} from "../stores/projects";
import type { Project } from "../ipc";
import ProjectSettingsDialog from "./ProjectSettingsDialog";

interface ProjectItemProps {
  project: Project;
  isActive: boolean;
  onSelect: (id: string) => void;
  onEdit: (project: Project) => void;
}

function ProjectItem(props: ProjectItemProps) {
  return (
    <div
      class={`group flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors duration-fast
        ${
          props.isActive
            ? "bg-surface-selected text-text-accent"
            : "text-text-secondary hover:bg-surface-hover hover:text-text-primary"
        }`}
    >
      {/* Main click area */}
      <button
        type="button"
        onClick={() => props.onSelect(props.project.id)}
        class="flex flex-1 items-center gap-3 overflow-hidden text-left"
        aria-current={props.isActive ? "true" : undefined}
      >
        {/* Color indicator */}
        <span
          class="h-2.5 w-2.5 shrink-0 rounded-full"
          style={{
            "background-color": props.project.color ?? "var(--color-neutral-500)",
          }}
        />

        {/* Icon or fallback */}
        <span class="shrink-0 text-base leading-none">
          {props.project.icon ?? "📁"}
        </span>

        {/* Project name */}
        <span class="truncate font-medium">{props.project.name}</span>
      </button>

      {/* Edit button — visible on hover, always visible for active */}
      <button
        type="button"
        onClick={() => props.onEdit(props.project)}
        class={`shrink-0 rounded-md p-1 transition-colors
          ${
            props.isActive
              ? "text-text-accent opacity-70 hover:opacity-100"
              : "text-text-tertiary opacity-0 group-hover:opacity-100 hover:bg-surface-hover hover:text-text-secondary"
          }`}
        title="Edit project"
      >
        ⚙️
      </button>

      {/* Active indicator bar */}
      <Show when={props.isActive}>
        <span class="ml-auto h-5 w-0.5 rounded-full bg-primary-500" />
      </Show>
    </div>
  );
}

export default function Sidebar() {
  const projects = getProjects;
  const loading = isProjectsLoading;

  const [editingProject, setEditingProject] = createSignal<Project | null>(null);
  const [dialogOpen, setDialogOpen] = createSignal(false);

  onMount(() => {
    void loadProjects();
  });

  function handleSelect(id: string) {
    selectProject(id);
  }

  function handleEdit(project: Project) {
    setEditingProject(project);
    setDialogOpen(true);
  }

  function handleDialogOpenChange(open: boolean) {
    setDialogOpen(open);
    if (!open) {
      setEditingProject(null);
    }
  }

  return (
    <>
      <aside
        class="flex h-full w-[var(--sidebar-width)] shrink-0 flex-col border-l border-surface-border bg-surface-elevated"
        aria-label="Projects"
      >
        {/* Header */}
        <div class="flex items-center justify-between border-b border-surface-border px-4 py-3">
          <h2 class="text-sm font-semibold text-text-primary">Projects</h2>
          <span class="text-xs text-text-tertiary">
            <Show when={!loading()} fallback="Loading…">
              {projects().length}
            </Show>
          </span>
        </div>

        {/* Project list */}
        <div class="flex-1 overflow-y-auto px-2 py-2">
          <Show
            when={!loading() && projects().length > 0}
            fallback={
              <Show
                when={!loading()}
                fallback={
                  <div class="flex h-32 items-center justify-center">
                    <span class="text-sm text-text-tertiary">Loading projects…</span>
                  </div>
                }
              >
                <div class="flex flex-col items-center justify-center gap-3 px-4 py-8 text-center">
                  <span class="text-2xl">📂</span>
                  <p class="text-sm text-text-secondary">No projects yet</p>
                  <p class="text-xs text-text-tertiary">
                    Add a project to get started with terminal sessions.
                  </p>
                </div>
              </Show>
            }
          >
            <ul class="space-y-0.5" role="list">
              <For each={projects()}>
                {(project) => (
                  <li>
                    <ProjectItem
                      project={project}
                      isActive={activeProjectId() === project.id}
                      onSelect={handleSelect}
                      onEdit={handleEdit}
                    />
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </div>

        {/* Footer — Add project (placeholder for T6.5) */}
        <div class="border-t border-surface-border p-2">
          <button
            type="button"
            disabled
            class="flex w-full items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-text-tertiary transition-colors duration-fast hover:bg-surface-hover hover:text-text-secondary disabled:cursor-not-allowed disabled:opacity-50"
            title="Add project — coming in T6.5"
          >
            <span class="text-base leading-none">+</span>
            Add project
          </button>
        </div>
      </aside>

      {/* Project settings dialog */}
      <Show when={editingProject()}>
        <ProjectSettingsDialog
          project={editingProject()!}
          open={dialogOpen()}
          onOpenChange={handleDialogOpenChange}
        />
      </Show>
    </>
  );
}
