/**
 * Projects store — reactive state for the project list and active selection.
 *
 * Hydrates from the Rust backend via `projectList()` IPC call.
 * Keeps a local active-project ID for UI highlighting; the actual
 * layout switching happens in `layout.ts` (T6.2).
 */

import { createSignal } from "solid-js";
import { createStore, produce } from "solid-js/store";
import type { Project } from "../ipc";
import { projectList, projectCreate, projectUpdate, projectDelete } from "../ipc";

/* ─── State shape ─── */

interface ProjectsState {
  /** Ordered list of projects (sorted by position from DB). */
  items: Project[];
  /** Whether the initial load is in flight. */
  loading: boolean;
  /** Last error message, if any. */
  error: string | null;
}

const [state, setState] = createStore<ProjectsState>({
  items: [],
  loading: false,
  error: null,
});

/** ID of the currently selected project in the sidebar. */
const [activeProjectId, setActiveProjectId] = createSignal<string | null>(null);

/* ─── Read helpers ─── */

/** All projects, ordered by DB position. */
export function getProjects(): Project[] {
  return state.items;
}

/** Whether projects are currently being loaded. */
export function isProjectsLoading(): boolean {
  return state.loading;
}

/** Any load error that occurred. */
export function getProjectsError(): string | null {
  return state.error;
}

/** The actively selected project ID (for sidebar highlight). */
export { activeProjectId };

/** Get the full Project object for the active ID, if any. */
export function getActiveProject(): Project | undefined {
  const id = activeProjectId();
  if (!id) return undefined;
  return state.items.find((p) => p.id === id);
}

/* ─── Write helpers ─── */

/** Load projects from the backend and replace local state. */
export async function loadProjects(): Promise<void> {
  setState("loading", true);
  setState("error", null);
  try {
    const projects = await projectList();
    setState("items", projects);

    // Auto-select first project if nothing is selected
    if (!activeProjectId() && projects.length > 0) {
      setActiveProjectId(projects[0].id);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setState("error", message);
  } finally {
    setState("loading", false);
  }
}

/** Set which project is active in the sidebar. */
export function selectProject(projectId: string | null): void {
  setActiveProjectId(projectId);
}

/** Add a new project locally and to the backend. */
export async function addProject(input: {
  name: string;
  path: string;
  color?: string | null;
  icon?: string | null;
}): Promise<Project> {
  const project = await projectCreate(input);
  setState(
    produce((s) => {
      s.items.push(project);
      s.items.sort((a, b) => a.position - b.position);
    }),
  );
  setActiveProjectId(project.id);
  return project;
}

/** Update an existing project locally and on the backend. */
export async function updateProject(
  id: string,
  input: Parameters<typeof projectUpdate>[1],
): Promise<Project> {
  const updated = await projectUpdate(id, input);
  setState(
    produce((s) => {
      const idx = s.items.findIndex((p) => p.id === id);
      if (idx !== -1) {
        s.items[idx] = updated;
        s.items.sort((a, b) => a.position - b.position);
      }
    }),
  );
  return updated;
}

/** Remove a project locally and from the backend. */
export async function removeProject(id: string): Promise<void> {
  await projectDelete(id);
  setState(
    produce((s) => {
      s.items = s.items.filter((p) => p.id !== id);
    }),
  );
  if (activeProjectId() === id) {
    const first = state.items[0];
    setActiveProjectId(first?.id ?? null);
  }
}
