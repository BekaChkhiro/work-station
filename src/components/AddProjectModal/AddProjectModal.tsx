// T6.5 + T6.6: Project form modal — used for both creating and editing.
//
// Purely presentational and controlled. The parent owns the open/closed
// state and provides:
//   • `onPickFolder` — async (typically `pickProjectFolder` from
//     ipc/picker), returning the chosen absolute path or null on cancel.
//     The component does not import the IPC layer directly so it stays
//     trivially harness-able without a Tauri runtime.
//   • `onSubmit` — async (wraps `createProject` for mode="create",
//     `updateProject` for mode="edit"). The component surfaces backend
//     validation messages by inspecting the rejection's `Error.message`.
//   • `onRequestDelete` (edit only) — fires when the destructive
//     "Delete project" button in the footer is pressed. The parent is
//     expected to render `DeleteProjectConfirm` on top of this modal.
//
// Behaviour:
//   • Esc closes (capture-phase listener — wins over xterm pane key
//     handling, same trick QuickSwitcher uses).
//   • Backdrop mousedown closes; clicks inside the modal don't.
//   • Enter on the form submits when the form is valid.
//   • The glyph defaults to the first two characters of the name in
//     uppercase. Once the user clicks an icon swatch, that override
//     sticks — typing more in the name no longer overwrites their pick.
//   • Color defaults to the first swatch token; the user can pick any of
//     the eight `--swatch-N` values.
//   • While `onSubmit` is in flight the form is disabled and the primary
//     button shows "Creating…" / "Saving…". On rejection the message
//     renders inline under the footer, the form re-enables, and focus
//     returns to Name.
//   • In edit mode the primary button stays disabled until the form is
//     dirty (any field differs from the initial value) — matches the
//     design spec ("Save changes" only enabled when dirty).

import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import type { JSX } from "solid-js";
import { PROJECT_CLI_OPTIONS } from "../../types/cli";

export type ProjectEnvVars = Record<string, string>;

export interface AddProjectFormValue {
  name: string;
  path: string;
  color: string;
  glyph: string;
  /** CLI id from `PROJECT_CLI_OPTIONS`, or `null` to inherit the global
   *  default (currently the system shell). Stored in `projects.default_cli`
   *  by the backend. */
  defaultCli: string | null;
  env: ProjectEnvVars;
  /** T7.6 — optional shell lines run before the main CLI in the same shell
   *  (e.g. `nvm use 20`, `source .env.local`). Order is preserved; empty/
   *  whitespace-only entries are dropped on submit. */
  startupCommands: string[];
}

export type ProjectFormMode = "create" | "edit";

export interface AddProjectModalProps {
  open: boolean;
  /** Default `"create"`. In `"edit"` mode the form prefills from
   *  `initialValue`, the title becomes "Edit project", the primary CTA
   *  becomes "Save changes" (dirty-only enabled), and a destructive
   *  "Delete project" button appears in the footer's bottom-left. */
  mode?: ProjectFormMode;
  /** Close without submitting. Always called from inside the modal —
   *  the parent decides what surface to return focus to. */
  onClose: () => void;
  /** Open the OS folder picker. Resolves to the absolute path or null on
   *  cancel. Passed in so the modal stays decoupled from the IPC layer. */
  onPickFolder: () => Promise<string | null>;
  /** Persist the form. May reject with a user-facing message — the modal
   *  renders the rejection's `.message`. On resolve the modal calls
   *  `onClose` itself. */
  onSubmit: (value: AddProjectFormValue) => Promise<void>;
  /** Initial path prefill for create mode (e.g. `~/code/`). Defaults to
   *  empty so the field is empty when no hint is available. Ignored in
   *  edit mode (use `initialValue`). */
  initialPath?: string;
  /** Required when `mode === "edit"`. Pre-fills the form and is the
   *  baseline used to compute the dirty state. */
  initialValue?: AddProjectFormValue;
  /** Edit-mode only — fires when the destructive Delete button is
   *  pressed. The parent typically opens the confirm modal on top. */
  onRequestDelete?: () => void;
}

// The eight `--swatch-N` tokens (defined in tokens.css). Centralised here
// so the modal and the harness pull from the same list.
export const PROJECT_SWATCHES = [
  "var(--swatch-1)",
  "var(--swatch-2)",
  "var(--swatch-3)",
  "var(--swatch-4)",
  "var(--swatch-5)",
  "var(--swatch-6)",
  "var(--swatch-7)",
  "var(--swatch-8)",
] as const;
const DEFAULT_SWATCH = PROJECT_SWATCHES[0];
const ENV_KEY_RE = /^[A-Z_][A-Z0-9_]*$/;

interface EnvRow {
  id: number;
  key: string;
  value: string;
}

interface StartupRow {
  id: number;
  value: string;
}

let nextEnvRowId = 1;
let nextStartupRowId = 1;

const toEnvRows = (env: ProjectEnvVars | undefined): EnvRow[] =>
  Object.entries(env ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => ({
      id: nextEnvRowId++,
      key,
      value,
    }));

const rowsToEnv = (rows: EnvRow[]): ProjectEnvVars => {
  const env: ProjectEnvVars = {};
  for (const row of rows) env[row.key.trim()] = row.value;
  return env;
};

const envEqual = (a: ProjectEnvVars, b: ProjectEnvVars): boolean => {
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  if (aKeys.length !== bKeys.length) return false;
  for (let i = 0; i < aKeys.length; i += 1) {
    const key = aKeys[i];
    const otherKey = bKeys[i];
    if (key === undefined || otherKey === undefined) return false;
    if (key !== otherKey || a[key] !== b[key]) return false;
  }
  return true;
};

const toStartupRows = (commands: readonly string[] | undefined): StartupRow[] =>
  (commands ?? []).map((value) => ({
    id: nextStartupRowId++,
    value,
  }));

// Drop whitespace-only entries — the backend treats them as no-ops anyway,
// and we want the dirty check to ignore an empty placeholder row the user
// added but didn't fill in.
const rowsToStartupCommands = (rows: readonly StartupRow[]): string[] =>
  rows.map((row) => row.value).filter((line) => line.trim().length > 0);

const startupCommandsEqual = (a: readonly string[], b: readonly string[]): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
};

// 12 two-letter glyph options — a reasonable, name-agnostic palette so the
// user can pick something that reads better than auto-derived initials.
// Source: DESIGN_PROMPT prototype (work-station-design/data.js WS_ICONS).
export const PROJECT_GLYPHS: readonly string[] = [
  "AR",
  "PU",
  "HX",
  "OR",
  "LM",
  "FO",
  "NB",
  "SK",
  "TM",
  "VL",
  "XR",
  "ZN",
];

const deriveGlyph = (name: string): string => {
  const trimmed = name.trim();
  if (trimmed.length === 0) return "PR";
  // Take the first two non-whitespace characters, uppercased. Falls back
  // to one char (with the second slot left blank) when the name is a
  // single character — the swatch renders fine either way.
  const compact = trimmed.replace(/\s+/g, "");
  return compact.slice(0, 2).toUpperCase();
};

export function AddProjectModal(props: AddProjectModalProps): JSX.Element {
  let nameInput: HTMLInputElement | undefined;

  const mode = (): ProjectFormMode => props.mode ?? "create";
  const isEdit = (): boolean => mode() === "edit";

  const [name, setName] = createSignal("");
  const [path, setPath] = createSignal("");
  const [color, setColor] = createSignal<string>(DEFAULT_SWATCH);
  // null = auto-derive from name; string = user-overridden glyph.
  const [glyphOverride, setGlyphOverride] = createSignal<string | null>(null);
  // null = "use system default shell"; string = a CLI id from PROJECT_CLI_OPTIONS.
  const [defaultCli, setDefaultCli] = createSignal<string | null>(null);
  const [envRows, setEnvRows] = createSignal<EnvRow[]>([]);
  const [environmentOpen, setEnvironmentOpen] = createSignal(true);
  const [startupRows, setStartupRows] = createSignal<StartupRow[]>([]);
  const [startupOpen, setStartupOpen] = createSignal(true);
  const [draggingStartupId, setDraggingStartupId] = createSignal<number | null>(null);
  const [submitting, setSubmitting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const effectiveGlyph = createMemo<string>(() => {
    const override = glyphOverride();
    if (override !== null) return override;
    return deriveGlyph(name());
  });

  const dirty = createMemo<boolean>(() => {
    if (!isEdit()) return true;
    const init = props.initialValue;
    if (!init) return true;
    return (
      name().trim() !== init.name.trim() ||
      path().trim() !== init.path.trim() ||
      color() !== init.color ||
      effectiveGlyph() !== init.glyph ||
      defaultCli() !== init.defaultCli ||
      !envEqual(rowsToEnv(envRows()), init.env) ||
      !startupCommandsEqual(rowsToStartupCommands(startupRows()), init.startupCommands)
    );
  });

  const envRowErrors = createMemo<Record<number, string>>(() => {
    const errors: Record<number, string> = {};
    const seen = new Map<string, number>();
    for (const row of envRows()) {
      const key = row.key.trim();
      if (key.length === 0) {
        errors[row.id] = "KEY is required.";
        continue;
      }
      if (!ENV_KEY_RE.test(key)) {
        errors[row.id] = "Use A-Z, 0-9, and _. Start with A-Z or _.";
        continue;
      }
      const first = seen.get(key);
      if (first !== undefined) {
        errors[row.id] = "KEY is duplicated.";
        errors[first] = "KEY is duplicated.";
        continue;
      }
      seen.set(key, row.id);
    }
    return errors;
  });

  const envValid = createMemo<boolean>(() => Object.keys(envRowErrors()).length === 0);

  const valid = createMemo<boolean>(() => {
    if (submitting()) return false;
    if (name().trim().length === 0 || path().trim().length === 0) return false;
    if (!envValid()) return false;
    if (isEdit() && !dirty()) return false;
    return true;
  });

  // Reset / hydrate the form each time the modal opens. Behaviour differs
  // by mode: create wipes to defaults; edit prefills from initialValue and
  // pins glyphOverride so the auto-derive logic doesn't fight the saved
  // glyph when the user edits the name.
  createEffect(() => {
    if (!props.open) return;
    if (isEdit() && props.initialValue) {
      const v = props.initialValue;
      setName(v.name);
      setPath(v.path);
      setColor(v.color);
      setGlyphOverride(v.glyph);
      setDefaultCli(v.defaultCli);
      setEnvRows(toEnvRows(v.env));
      setEnvironmentOpen(Object.keys(v.env).length > 0);
      setStartupRows(toStartupRows(v.startupCommands));
      setStartupOpen(v.startupCommands.length > 0);
    } else {
      setName("");
      setPath(props.initialPath ?? "");
      setColor(DEFAULT_SWATCH);
      setGlyphOverride(null);
      setDefaultCli(null);
      setEnvRows([]);
      setEnvironmentOpen(false);
      setStartupRows([]);
      setStartupOpen(false);
    }
    setDraggingStartupId(null);
    setSubmitting(false);
    setError(null);
    queueMicrotask(() => nameInput?.focus());
  });

  // Escape from anywhere inside the modal — capture-phase, like the
  // QuickSwitcher handler, so it wins over xterm's hidden textarea even
  // when a pane has focus. Only mounted while open to avoid leaking.
  createEffect(() => {
    if (!props.open) return;
    const onDocKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (!submitting()) props.onClose();
      }
    };
    document.addEventListener("keydown", onDocKey, { capture: true });
    onCleanup(() => document.removeEventListener("keydown", onDocKey, { capture: true }));
  });

  const handleBrowse = async (): Promise<void> => {
    if (submitting()) return;
    try {
      const picked = await props.onPickFolder();
      if (picked) setPath(picked);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSubmit = async (event: Event): Promise<void> => {
    event.preventDefault();
    if (!valid()) return;
    setError(null);
    setSubmitting(true);
    try {
      await props.onSubmit({
        name: name().trim(),
        path: path().trim(),
        color: color(),
        glyph: effectiveGlyph(),
        defaultCli: defaultCli(),
        env: rowsToEnv(envRows()),
        startupCommands: rowsToStartupCommands(startupRows()),
      });
      props.onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
      queueMicrotask(() => nameInput?.focus());
    }
  };

  const addEnvRow = (): void => {
    setEnvRows((rows) => [...rows, { id: nextEnvRowId++, key: "", value: "" }]);
    setEnvironmentOpen(true);
  };

  const updateEnvRow = (id: number, patch: Partial<Omit<EnvRow, "id">>): void => {
    setEnvRows((rows) => rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  };

  const deleteEnvRow = (id: number): void => {
    setEnvRows((rows) => rows.filter((row) => row.id !== id));
  };

  const addStartupRow = (): void => {
    setStartupRows((rows) => [...rows, { id: nextStartupRowId++, value: "" }]);
    setStartupOpen(true);
  };

  const updateStartupRow = (id: number, value: string): void => {
    setStartupRows((rows) => rows.map((row) => (row.id === id ? { ...row, value } : row)));
  };

  const deleteStartupRow = (id: number): void => {
    setStartupRows((rows) => rows.filter((row) => row.id !== id));
  };

  const moveStartupRow = (id: number, delta: -1 | 1): void => {
    setStartupRows((rows) => {
      const idx = rows.findIndex((row) => row.id === id);
      if (idx === -1) return rows;
      const target = idx + delta;
      if (target < 0 || target >= rows.length) return rows;
      const next = rows.slice();
      const [moved] = next.splice(idx, 1);
      if (!moved) return rows;
      next.splice(target, 0, moved);
      return next;
    });
  };

  // Native HTML5 drag-and-drop is plenty for a small modal list; the
  // pointer-capture dance the Sidebar uses (T6.7) only matters because the
  // grip lives next to a clickable row that can't itself be `draggable`.
  // Here the entire row participates so dataTransfer can stay bare.
  const handleStartupDrop = (targetId: number): void => {
    const sourceId = draggingStartupId();
    if (sourceId === null || sourceId === targetId) {
      setDraggingStartupId(null);
      return;
    }
    setStartupRows((rows) => {
      const fromIdx = rows.findIndex((row) => row.id === sourceId);
      const toIdx = rows.findIndex((row) => row.id === targetId);
      if (fromIdx === -1 || toIdx === -1) return rows;
      const next = rows.slice();
      const [moved] = next.splice(fromIdx, 1);
      if (!moved) return rows;
      next.splice(toIdx, 0, moved);
      return next;
    });
    setDraggingStartupId(null);
  };

  return (
    <Show when={props.open}>
      <div
        class="ws-apm__backdrop"
        onMouseDown={(e) => {
          if (e.currentTarget === e.target && !submitting()) props.onClose();
        }}
      >
        <form
          class="ws-apm"
          role="dialog"
          aria-label={isEdit() ? "Edit project" : "New project"}
          aria-modal="true"
          onMouseDown={(e) => e.stopPropagation()}
          onSubmit={handleSubmit}
        >
          <header class="ws-apm__head">
            <span class="ws-apm__title">{isEdit() ? "Edit project" : "New project"}</span>
            <button
              type="button"
              class="ws-apm__icon-btn"
              aria-label="Close"
              onClick={() => {
                if (!submitting()) props.onClose();
              }}
            >
              <IconX />
            </button>
          </header>

          <div class="ws-apm__body">
            <label class="ws-apm__field">
              <span class="ws-apm__field-label">Name</span>
              <input
                ref={nameInput}
                class="ws-apm__input"
                type="text"
                value={name()}
                onInput={(e) => setName(e.currentTarget.value)}
                placeholder="my-project"
                spellcheck={false}
                autocomplete="off"
                disabled={submitting()}
                required
              />
            </label>

            <div class="ws-apm__field">
              <span class="ws-apm__field-label">Folder</span>
              <div class="ws-apm__input-wrap">
                <span class="ws-apm__input-icon" aria-hidden="true">
                  <IconFolder />
                </span>
                <input
                  class="ws-apm__input ws-apm__input--has-icon"
                  type="text"
                  value={path()}
                  onInput={(e) => setPath(e.currentTarget.value)}
                  placeholder="/Users/you/code/my-project"
                  spellcheck={false}
                  autocomplete="off"
                  disabled={submitting()}
                />
                <span class="ws-apm__input-aside">
                  <button
                    type="button"
                    class="ws-apm__btn ws-apm__btn--ghost ws-apm__btn--sm"
                    onClick={() => void handleBrowse()}
                    disabled={submitting()}
                  >
                    Browse…
                  </button>
                </span>
              </div>
            </div>

            <div class="ws-apm__row">
              <div class="ws-apm__field">
                <span class="ws-apm__field-label">Color</span>
                <div class="ws-apm__swatches" role="radiogroup" aria-label="Color">
                  <For each={PROJECT_SWATCHES}>
                    {(swatch) => {
                      const selected = (): boolean => swatch === color();
                      return (
                        <button
                          type="button"
                          class="ws-apm__swatch"
                          data-selected={selected() ? "true" : undefined}
                          style={{ background: swatch }}
                          aria-label={`Color ${swatch}`}
                          aria-pressed={selected()}
                          role="radio"
                          aria-checked={selected()}
                          onClick={() => setColor(swatch)}
                          disabled={submitting()}
                        />
                      );
                    }}
                  </For>
                </div>
              </div>

              <div class="ws-apm__field">
                <span class="ws-apm__field-label">Preview</span>
                <div class="ws-apm__preview" aria-hidden="true">
                  <span class="ws-apm__preview-icon" style={{ background: color() }}>
                    {effectiveGlyph()}
                  </span>
                  <span class="ws-apm__preview-name">
                    {name().trim().length > 0 ? name().trim() : "Untitled"}
                  </span>
                </div>
              </div>
            </div>

            <div class="ws-apm__field">
              <span class="ws-apm__field-label">Default CLI</span>
              <div class="ws-apm__cli-grid" role="radiogroup" aria-label="Default CLI">
                <button
                  type="button"
                  class="ws-apm__cli"
                  data-selected={defaultCli() === null ? "true" : undefined}
                  role="radio"
                  aria-checked={defaultCli() === null}
                  onClick={() => setDefaultCli(null)}
                  disabled={submitting()}
                >
                  <span class="ws-apm__cli-name">System default</span>
                  <span class="ws-apm__cli-desc">Use the OS shell</span>
                </button>
                <For each={PROJECT_CLI_OPTIONS}>
                  {(cli) => {
                    const selected = (): boolean => cli.id === defaultCli();
                    return (
                      <button
                        type="button"
                        class="ws-apm__cli"
                        data-selected={selected() ? "true" : undefined}
                        role="radio"
                        aria-checked={selected()}
                        onClick={() => setDefaultCli(cli.id)}
                        disabled={submitting()}
                      >
                        <span class="ws-apm__cli-name">{cli.name}</span>
                        <span class="ws-apm__cli-desc">{cli.description}</span>
                      </button>
                    );
                  }}
                </For>
              </div>
            </div>

            <section class="ws-apm__section">
              <button
                type="button"
                class="ws-apm__section-head"
                aria-expanded={environmentOpen()}
                onClick={() => setEnvironmentOpen((open) => !open)}
                disabled={submitting()}
              >
                <span class="ws-apm__field-label">Environment</span>
                <span class="ws-apm__section-chevron" aria-hidden="true">
                  {environmentOpen() ? "−" : "+"}
                </span>
              </button>
              <Show when={environmentOpen()}>
                <div class="ws-apm__env-list">
                  <Show
                    when={envRows().length > 0}
                    fallback={<div class="ws-apm__empty-note">No variables configured.</div>}
                  >
                    <For each={envRows()}>
                      {(row) => {
                        const rowError = (): string | undefined => envRowErrors()[row.id];
                        return (
                          <div class="ws-apm__env-row-wrap">
                            <div class="ws-apm__env-row">
                              <input
                                class="ws-apm__input ws-apm__input--mono ws-apm__env-key"
                                type="text"
                                value={row.key}
                                onInput={(e) =>
                                  updateEnvRow(row.id, {
                                    key: e.currentTarget.value.toUpperCase(),
                                  })
                                }
                                placeholder="NODE_ENV"
                                spellcheck={false}
                                autocomplete="off"
                                aria-invalid={rowError() ? "true" : "false"}
                                disabled={submitting()}
                              />
                              <span class="ws-apm__env-equals">=</span>
                              <input
                                class="ws-apm__input ws-apm__input--mono ws-apm__env-value"
                                type="text"
                                value={row.value}
                                onInput={(e) =>
                                  updateEnvRow(row.id, { value: e.currentTarget.value })
                                }
                                placeholder="development"
                                spellcheck={false}
                                autocomplete="off"
                                disabled={submitting()}
                              />
                              <button
                                type="button"
                                class="ws-apm__icon-btn ws-apm__env-delete"
                                aria-label={`Delete ${row.key.trim() || "environment variable"}`}
                                onClick={() => deleteEnvRow(row.id)}
                                disabled={submitting()}
                              >
                                <IconX />
                              </button>
                            </div>
                            <Show when={rowError()}>
                              <div class="ws-apm__field-error">{rowError()}</div>
                            </Show>
                          </div>
                        );
                      }}
                    </For>
                  </Show>
                  <button
                    type="button"
                    class="ws-apm__btn ws-apm__btn--ghost ws-apm__btn--sm ws-apm__env-add"
                    onClick={addEnvRow}
                    disabled={submitting()}
                  >
                    + Add variable
                  </button>
                </div>
              </Show>
            </section>

            <section class="ws-apm__section">
              <button
                type="button"
                class="ws-apm__section-head"
                aria-expanded={startupOpen()}
                onClick={() => setStartupOpen((open) => !open)}
                disabled={submitting()}
              >
                <span class="ws-apm__field-label">Startup commands</span>
                <span class="ws-apm__section-chevron" aria-hidden="true">
                  {startupOpen() ? "−" : "+"}
                </span>
              </button>
              <Show when={startupOpen()}>
                <div class="ws-apm__startup-list">
                  <Show
                    when={startupRows().length > 0}
                    fallback={
                      <div class="ws-apm__empty-note">
                        Run before the main CLI in the same shell (e.g. <code>nvm use 20</code>).
                      </div>
                    }
                  >
                    <For each={startupRows()}>
                      {(row, index) => {
                        const isFirst = (): boolean => index() === 0;
                        const isLast = (): boolean => index() === startupRows().length - 1;
                        const dragging = (): boolean => draggingStartupId() === row.id;
                        return (
                          <div
                            class="ws-apm__startup-row"
                            data-dragging={dragging() ? "true" : undefined}
                            onDragOver={(e) => {
                              if (draggingStartupId() === null) return;
                              e.preventDefault();
                            }}
                            onDrop={(e) => {
                              if (draggingStartupId() === null) return;
                              e.preventDefault();
                              handleStartupDrop(row.id);
                            }}
                          >
                            <span
                              class="ws-apm__startup-grip"
                              draggable={!submitting()}
                              role="button"
                              aria-label={`Reorder command ${index() + 1}`}
                              tabIndex={0}
                              onDragStart={(e) => {
                                if (submitting()) {
                                  e.preventDefault();
                                  return;
                                }
                                setDraggingStartupId(row.id);
                                if (e.dataTransfer) {
                                  e.dataTransfer.effectAllowed = "move";
                                  // Required by Firefox for drag to fire.
                                  e.dataTransfer.setData("text/plain", String(row.id));
                                }
                              }}
                              onDragEnd={() => setDraggingStartupId(null)}
                              onKeyDown={(e) => {
                                if (e.key === "ArrowUp") {
                                  e.preventDefault();
                                  if (!isFirst()) moveStartupRow(row.id, -1);
                                } else if (e.key === "ArrowDown") {
                                  e.preventDefault();
                                  if (!isLast()) moveStartupRow(row.id, 1);
                                }
                              }}
                            >
                              <GripDots />
                            </span>
                            <input
                              class="ws-apm__input ws-apm__input--mono ws-apm__startup-input"
                              type="text"
                              value={row.value}
                              onInput={(e) => updateStartupRow(row.id, e.currentTarget.value)}
                              placeholder="nvm use 20"
                              spellcheck={false}
                              autocomplete="off"
                              disabled={submitting()}
                            />
                            <button
                              type="button"
                              class="ws-apm__icon-btn ws-apm__startup-delete"
                              aria-label={`Delete command ${index() + 1}`}
                              onClick={() => deleteStartupRow(row.id)}
                              disabled={submitting()}
                            >
                              <IconX />
                            </button>
                          </div>
                        );
                      }}
                    </For>
                  </Show>
                  <button
                    type="button"
                    class="ws-apm__btn ws-apm__btn--ghost ws-apm__btn--sm ws-apm__startup-add"
                    onClick={addStartupRow}
                    disabled={submitting()}
                  >
                    + Add command
                  </button>
                </div>
              </Show>
            </section>

            <div class="ws-apm__field">
              <span class="ws-apm__field-label">Icon glyph</span>
              <div class="ws-apm__icon-grid" role="radiogroup" aria-label="Icon glyph">
                <For each={PROJECT_GLYPHS}>
                  {(g) => {
                    const selected = (): boolean => g === effectiveGlyph();
                    return (
                      <button
                        type="button"
                        class="ws-apm__icon-pick"
                        data-selected={selected() ? "true" : undefined}
                        aria-label={`Glyph ${g}`}
                        aria-pressed={selected()}
                        role="radio"
                        aria-checked={selected()}
                        onClick={() => setGlyphOverride(g)}
                        disabled={submitting()}
                      >
                        {g}
                      </button>
                    );
                  }}
                </For>
              </div>
            </div>

            <Show when={error()}>
              <div class="ws-apm__error" role="alert">
                {error()}
              </div>
            </Show>
          </div>

          <footer class="ws-apm__foot">
            <Show when={isEdit() && props.onRequestDelete}>
              <button
                type="button"
                class="ws-apm__btn ws-apm__btn--danger-text"
                onClick={() => {
                  if (!submitting()) props.onRequestDelete?.();
                }}
                disabled={submitting()}
              >
                Delete project
              </button>
            </Show>
            <span class="ws-apm__foot-spacer" />
            <button
              type="button"
              class="ws-apm__btn ws-apm__btn--ghost"
              onClick={() => {
                if (!submitting()) props.onClose();
              }}
              disabled={submitting()}
            >
              Cancel
            </button>
            <button type="submit" class="ws-apm__btn ws-apm__btn--primary" disabled={!valid()}>
              {submitting()
                ? isEdit()
                  ? "Saving…"
                  : "Creating…"
                : isEdit()
                  ? "Save changes"
                  : "Create project"}
            </button>
          </footer>
        </form>
      </div>
    </Show>
  );
}

function IconX(): JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" aria-hidden="true">
      <path
        d="M3 3 L10 10 M10 3 L3 10"
        stroke="currentColor"
        stroke-width="1.4"
        stroke-linecap="round"
      />
    </svg>
  );
}

// 6×6 grip-dots — same visual treatment as the Sidebar drag handle (T6.7).
function GripDots(): JSX.Element {
  return (
    <svg width="8" height="12" viewBox="0 0 8 12" aria-hidden="true">
      <g fill="currentColor">
        <circle cx="2" cy="2" r="1" />
        <circle cx="6" cy="2" r="1" />
        <circle cx="2" cy="6" r="1" />
        <circle cx="6" cy="6" r="1" />
        <circle cx="2" cy="10" r="1" />
        <circle cx="6" cy="10" r="1" />
      </g>
    </svg>
  );
}

function IconFolder(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path
        d="M1.5 4.2 V11 a1.2 1.2 0 0 0 1.2 1.2 H11.3 a1.2 1.2 0 0 0 1.2 -1.2 V5.4 a1.2 1.2 0 0 0 -1.2 -1.2 H6.4 L5 3 H2.7 a1.2 1.2 0 0 0 -1.2 1.2 z"
        stroke="currentColor"
        stroke-width="1.3"
        stroke-linejoin="round"
      />
    </svg>
  );
}

export default AddProjectModal;
