/**
 * ProjectSettingsDialog — edit project properties including per-project env vars.
 *
 * Uses Kobalte Dialog primitives. Env vars are edited as a list of key-value
 * pairs and serialized to JSON for storage.
 */

import { createSignal, For, Show, untrack } from "solid-js";
import { Dialog } from "@kobalte/core/dialog";
import type { Project } from "../ipc";
import { updateProject } from "../stores/projects";

interface EnvEntry {
  key: string;
  value: string;
}

interface ProjectSettingsDialogProps {
  project: Project;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function parseEnv(json: string | null): EnvEntry[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as Record<string, string>;
    return Object.entries(parsed).map(([key, value]) => ({ key, value }));
  } catch {
    return [];
  }
}

function serializeEnv(entries: EnvEntry[]): string | null {
  const obj: Record<string, string> = {};
  for (const e of entries) {
    const key = e.key.trim();
    if (key) obj[key] = e.value;
  }
  return Object.keys(obj).length > 0 ? JSON.stringify(obj) : null;
}

export default function ProjectSettingsDialog(props: ProjectSettingsDialogProps) {
  const [name, setName] = createSignal(untrack(() => props.project.name));
  const [path, setPath] = createSignal(untrack(() => props.project.path));
  const [color, setColor] = createSignal(untrack(() => props.project.color ?? ""));
  const [icon, setIcon] = createSignal(untrack(() => props.project.icon ?? ""));
  const [defaultCli, setDefaultCli] = createSignal(untrack(() => props.project.default_cli ?? ""));
  const [startupCommands, setStartupCommands] = createSignal(untrack(() => props.project.startup_commands ?? ""));
  const [envEntries, setEnvEntries] = createSignal<EnvEntry[]>(untrack(() => parseEnv(props.project.env_json)));
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await updateProject(props.project.id, {
        name: name().trim() || undefined,
        path: path().trim() || undefined,
        color: color().trim() || null,
        icon: icon().trim() || null,
        default_cli: defaultCli().trim() || null,
        startup_commands: startupCommands().trim() || null,
        env_json: serializeEnv(envEntries()),
      });
      props.onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const addEnvEntry = () => {
    setEnvEntries((prev) => [...prev, { key: "", value: "" }]);
  };

  const removeEnvEntry = (index: number) => {
    setEnvEntries((prev) => prev.filter((_, i) => i !== index));
  };

  const updateEnvEntry = (index: number, field: "key" | "value", value: string) => {
    setEnvEntries((prev) =>
      prev.map((entry, i) => (i === index ? { ...entry, [field]: value } : entry)),
    );
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay class="fixed inset-0 z-50 bg-surface-overlay backdrop-blur-sm" />
        <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
          <Dialog.Content class="w-full max-w-lg rounded-lg border border-surface-border bg-surface-elevated shadow-lg">
            {/* Header */}
            <div class="flex items-center justify-between border-b border-surface-border px-4 py-3">
              <Dialog.Title class="text-sm font-semibold text-text-primary">
                Project Settings
              </Dialog.Title>
              <Dialog.CloseButton class="rounded-md p-1 text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text-secondary">
                ✕
              </Dialog.CloseButton>
            </div>

            {/* Body */}
            <div class="flex flex-col gap-4 px-4 py-4">
              {/* Name */}
              <div class="flex flex-col gap-1">
                <label class="text-xs font-medium text-text-secondary">Name</label>
                <input
                  type="text"
                  value={name()}
                  onInput={(e) => setName(e.currentTarget.value)}
                  class="rounded-md border border-surface-border bg-surface-base px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:border-primary-500 focus:outline-none"
                />
              </div>

              {/* Path */}
              <div class="flex flex-col gap-1">
                <label class="text-xs font-medium text-text-secondary">Path</label>
                <input
                  type="text"
                  value={path()}
                  onInput={(e) => setPath(e.currentTarget.value)}
                  class="rounded-md border border-surface-border bg-surface-base px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:border-primary-500 focus:outline-none"
                />
              </div>

              {/* Color & Icon row */}
              <div class="grid grid-cols-2 gap-3">
                <div class="flex flex-col gap-1">
                  <label class="text-xs font-medium text-text-secondary">Color</label>
                  <input
                    type="text"
                    value={color()}
                    onInput={(e) => setColor(e.currentTarget.value)}
                    placeholder="#8b5cf6"
                    class="rounded-md border border-surface-border bg-surface-base px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:border-primary-500 focus:outline-none"
                  />
                </div>
                <div class="flex flex-col gap-1">
                  <label class="text-xs font-medium text-text-secondary">Icon</label>
                  <input
                    type="text"
                    value={icon()}
                    onInput={(e) => setIcon(e.currentTarget.value)}
                    placeholder="📁"
                    class="rounded-md border border-surface-border bg-surface-base px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:border-primary-500 focus:outline-none"
                  />
                </div>
              </div>

              {/* Default CLI */}
              <div class="flex flex-col gap-1">
                <label class="text-xs font-medium text-text-secondary">Default CLI</label>
                <input
                  type="text"
                  value={defaultCli()}
                  onInput={(e) => setDefaultCli(e.currentTarget.value)}
                  placeholder="/bin/zsh"
                  class="rounded-md border border-surface-border bg-surface-base px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:border-primary-500 focus:outline-none"
                />
              </div>

              {/* Startup Commands */}
              <div class="flex flex-col gap-1">
                <label class="text-xs font-medium text-text-secondary">Startup Commands</label>
                <textarea
                  value={startupCommands()}
                  onInput={(e) => setStartupCommands(e.currentTarget.value)}
                  placeholder="nvm use 20&#10;source .env"
                  rows={3}
                  class="resize-none rounded-md border border-surface-border bg-surface-base px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:border-primary-500 focus:outline-none"
                />
                <p class="text-xs text-text-tertiary">One command per line. Run automatically in each new terminal.</p>
              </div>

              {/* Env vars */}
              <div class="flex flex-col gap-2">
                <div class="flex items-center justify-between">
                  <label class="text-xs font-medium text-text-secondary">Environment Variables</label>
                  <button
                    type="button"
                    onClick={addEnvEntry}
                    class="rounded-md px-2 py-1 text-xs font-medium text-primary-400 transition-colors hover:bg-surface-hover"
                  >
                    + Add
                  </button>
                </div>

                <Show
                  when={envEntries().length > 0}
                  fallback={
                    <p class="text-xs text-text-tertiary">
                      No environment variables set for this project.
                    </p>
                  }
                >
                  <div class="flex flex-col gap-2">
                    <For each={envEntries()}>
                      {(entry, index) => (
                        <div class="flex items-center gap-2">
                          <input
                            type="text"
                            value={entry.key}
                            onInput={(e) => updateEnvEntry(index(), "key", e.currentTarget.value)}
                            placeholder="KEY"
                            class="min-w-0 flex-1 rounded-md border border-surface-border bg-surface-base px-3 py-1.5 text-xs text-text-primary placeholder:text-text-tertiary focus:border-primary-500 focus:outline-none"
                          />
                          <span class="text-xs text-text-tertiary">=</span>
                          <input
                            type="text"
                            value={entry.value}
                            onInput={(e) =>
                              updateEnvEntry(index(), "value", e.currentTarget.value)
                            }
                            placeholder="value"
                            class="min-w-0 flex-1 rounded-md border border-surface-border bg-surface-base px-3 py-1.5 text-xs text-text-primary placeholder:text-text-tertiary focus:border-primary-500 focus:outline-none"
                          />
                          <button
                            type="button"
                            onClick={() => removeEnvEntry(index())}
                            class="rounded-md p-1 text-text-tertiary transition-colors hover:bg-surface-hover hover:text-danger"
                            title="Remove"
                          >
                            🗑
                          </button>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>
              </div>

              {/* Error */}
              <Show when={error()}>
                <p class="text-xs text-danger">{error()}</p>
              </Show>
            </div>

            {/* Footer */}
            <div class="flex items-center justify-end gap-2 border-t border-surface-border px-4 py-3">
              <Dialog.CloseButton class="rounded-md px-3 py-2 text-sm font-medium text-text-secondary transition-colors hover:bg-surface-hover">
                Cancel
              </Dialog.CloseButton>
              <button
                type="button"
                onClick={handleSave}
                disabled={saving()}
                class="rounded-md bg-primary-600 px-3 py-2 text-sm font-medium text-text-inverse transition-colors hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Show when={!saving()} fallback="Saving…">
                  Save
                </Show>
              </button>
            </div>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog>
  );
}
