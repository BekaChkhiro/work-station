// T6.6: Edit / delete flow harness — mocked end-to-end without Tauri.
//
// Reachable via `?wsdebug=editproject` in dev builds. Useful for exercising
// the visual treatment + interaction (right-click menu, hover pencil,
// dirty-only Save, 500ms safety delay on Delete) without spinning up the
// full AppShell with real PTYs.

import { For, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { Sidebar } from "../Sidebar";
import type { SidebarProject } from "../Sidebar";
import { AddProjectModal } from "../AddProjectModal";
import type { AddProjectFormValue } from "../AddProjectModal";
import { DeleteProjectConfirm } from "../DeleteProjectConfirm";
import { ProjectContextMenu } from "../ProjectContextMenu";

interface MockRow {
  id: string;
  name: string;
  path: string;
  color: string;
  glyph: string;
  sessions: number;
}

const SEED: MockRow[] = [
  {
    id: "argon",
    name: "argon-web",
    path: "/Users/you/code/argon-web",
    color: "var(--swatch-4)",
    glyph: "AR",
    sessions: 4,
  },
  {
    id: "kepler",
    name: "kepler-cli",
    path: "/Users/you/code/kepler-cli",
    color: "var(--swatch-6)",
    glyph: "KE",
    sessions: 0,
  },
  {
    id: "borealis",
    name: "borealis-api",
    path: "/Users/you/projects/borealis",
    color: "var(--swatch-3)",
    glyph: "BO",
    sessions: 1,
  },
];

const FAKE_PICKER_PATHS = ["/Users/you/code/new-project", "/Users/you/projects/another"];

interface ContextState {
  projectId: string;
  position: { x: number; y: number };
}

export function EditProjectFlowLiveHarness(): JSX.Element {
  const [rows, setRows] = createSignal<MockRow[]>(SEED);
  const [activeId, setActiveId] = createSignal<string>("argon");
  const [collapsed, setCollapsed] = createSignal(false);
  const [editId, setEditId] = createSignal<string | null>(null);
  const [deleteId, setDeleteId] = createSignal<string | null>(null);
  const [contextTarget, setContextTarget] = createSignal<ContextState | null>(null);
  const [pickerIdx, setPickerIdx] = createSignal(0);
  const [forceError, setForceError] = createSignal(false);
  const [log, setLog] = createSignal<string[]>([]);

  const append = (line: string): void => {
    setLog((l) => [...l, `${new Date().toISOString().slice(11, 19)} — ${line}`]);
  };

  const pickFolder = async (): Promise<string | null> => {
    const path = FAKE_PICKER_PATHS[pickerIdx() % FAKE_PICKER_PATHS.length] ?? null;
    setPickerIdx((i) => i + 1);
    await new Promise((r) => setTimeout(r, 100));
    return path;
  };

  const editTarget = (): MockRow | null => {
    const id = editId();
    if (!id) return null;
    return rows().find((r) => r.id === id) ?? null;
  };

  const deleteTarget = (): MockRow | null => {
    const id = deleteId();
    if (!id) return null;
    return rows().find((r) => r.id === id) ?? null;
  };

  const editInitial = (): AddProjectFormValue | undefined => {
    const t = editTarget();
    if (!t) return undefined;
    return { name: t.name, path: t.path, color: t.color, glyph: t.glyph };
  };

  const onEditSubmit = async (value: AddProjectFormValue): Promise<void> => {
    await new Promise((r) => setTimeout(r, 250));
    if (forceError()) {
      throw new Error('A project named "' + value.name + '" already exists.');
    }
    const id = editId();
    if (!id) return;
    setRows((list) =>
      list.map((r) =>
        r.id === id
          ? { ...r, name: value.name, path: value.path, color: value.color, glyph: value.glyph }
          : r,
      ),
    );
    append(`edit(${id}) → ${value.name} · ${value.glyph} · ${value.color}`);
  };

  const onDeleteConfirm = async (): Promise<void> => {
    await new Promise((r) => setTimeout(r, 200));
    const id = deleteId();
    if (!id) return;
    setRows((list) => list.filter((r) => r.id !== id));
    append(`delete(${id})`);
    setDeleteId(null);
    setEditId(null);
  };

  const sidebarRows = (): SidebarProject[] =>
    rows().map((r) => ({
      id: r.id,
      name: r.name,
      color: r.color,
      glyph: r.glyph,
      sessions: r.sessions,
    }));

  return (
    <div class="grid h-full w-full grid-cols-[1fr_auto] bg-canvas text-fg">
      <div class="flex min-h-0 flex-col gap-3 p-4">
        <div class="rounded-md border border-border-default bg-surface p-3 text-xs">
          <div class="font-semibold">Edit / Delete project flow harness (T6.6)</div>
          <div class="mt-1 text-fg-secondary">
            Hover a sidebar row → click the pencil icon, or right-click → "Edit…", to open the Edit
            modal. The Save button stays disabled until the form is dirty. The Edit footer's red
            "Delete project" link opens the destructive confirm modal — the Delete button has a
            500ms progress fill before it arms (Enter is also blocked during that window).
          </div>
          <label class="mt-2 inline-flex items-center gap-1.5 text-fg-secondary">
            <input
              type="checkbox"
              checked={forceError()}
              onChange={(e) => setForceError(e.currentTarget.checked)}
            />
            Force backend error on Save
          </label>
        </div>
        <div class="rounded-md border border-border-default bg-surface p-3 font-mono text-[11px] text-fg-secondary">
          <div class="mb-1 font-semibold text-fg">Log ({log().length})</div>
          {log().length === 0 ? (
            <div class="text-fg-tertiary">No actions yet.</div>
          ) : (
            <ul class="flex flex-col gap-0.5">
              <For each={log()}>{(line) => <li>{line}</li>}</For>
            </ul>
          )}
        </div>
      </div>
      <Sidebar
        projects={sidebarRows()}
        activeId={activeId()}
        collapsed={collapsed()}
        newProjectShortcut="⌘N"
        onActivate={(id) => setActiveId(id)}
        onAdd={() => append("add (no-op in this harness — see ?wsdebug=addproject)")}
        onEdit={(id) => setEditId(id)}
        onContextMenu={(id, x, y) => setContextTarget({ projectId: id, position: { x, y } })}
        onSettings={() => append("settings")}
        onToggleCollapse={() => setCollapsed((c) => !c)}
      />
      <AddProjectModal
        open={editId() !== null}
        mode="edit"
        initialValue={editInitial()}
        onClose={() => setEditId(null)}
        onPickFolder={pickFolder}
        onSubmit={onEditSubmit}
        onRequestDelete={() => {
          const id = editId();
          if (id) setDeleteId(id);
        }}
      />
      <DeleteProjectConfirm
        open={deleteId() !== null}
        projectName={deleteTarget()?.name ?? ""}
        runningSessions={deleteTarget()?.sessions ?? 0}
        onCancel={() => setDeleteId(null)}
        onConfirm={onDeleteConfirm}
      />
      <ProjectContextMenu
        position={contextTarget()?.position ?? null}
        onClose={() => setContextTarget(null)}
        onSwitch={() => {
          const t = contextTarget();
          if (t) {
            setActiveId(t.projectId);
            append(`switch(${t.projectId})`);
          }
        }}
        onEdit={() => {
          const t = contextTarget();
          if (t) setEditId(t.projectId);
        }}
        onReveal={() => {
          const t = contextTarget();
          if (t) append(`reveal(${t.projectId}) — would call revealItemInDir`);
        }}
        onDelete={() => {
          const t = contextTarget();
          if (t) setDeleteId(t.projectId);
        }}
      />
    </div>
  );
}

export default EditProjectFlowLiveHarness;
