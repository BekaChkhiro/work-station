// T6.5: Add Project modal harness — standalone, no Tauri runtime needed.
//
// Reachable via `?wsdebug=addproject` in dev builds. Useful for tightening
// the visual treatment of the modal without spinning up the full AppShell
// (which spawns three real PTYs and only runs inside the Tauri window).

import { For, createSignal } from "solid-js";
import type { JSX } from "solid-js";
import { AddProjectModal } from "./AddProjectModal";
import type { AddProjectFormValue } from "./AddProjectModal";

interface MockSubmission extends AddProjectFormValue {
  at: number;
}

const FAKE_PICKER_PATHS = [
  "/Users/beqolozi/code/argon-web",
  "/Users/beqolozi/code/kepler-cli",
  "/Users/beqolozi/projects/borealis",
];

export function AddProjectModalLiveHarness(): JSX.Element {
  const [open, setOpen] = createSignal(true);
  const [submissions, setSubmissions] = createSignal<MockSubmission[]>([]);
  const [pickerIdx, setPickerIdx] = createSignal(0);
  const [forceError, setForceError] = createSignal(false);

  const onPickFolder = async (): Promise<string | null> => {
    const path = FAKE_PICKER_PATHS[pickerIdx() % FAKE_PICKER_PATHS.length] ?? null;
    setPickerIdx((i) => i + 1);
    // Tiny artificial delay — closer to the native dialog round-trip so the
    // disabled state on the form during browse is exercised.
    await new Promise((r) => setTimeout(r, 120));
    return path;
  };

  const onSubmit = async (value: AddProjectFormValue): Promise<void> => {
    await new Promise((r) => setTimeout(r, 250));
    if (forceError()) {
      throw new Error('A project named "' + value.name + '" already exists.');
    }
    setSubmissions((list) => [...list, { ...value, at: Date.now() }]);
  };

  return (
    <div class="grid h-full w-full grid-rows-[auto_1fr] gap-2 bg-canvas p-3 text-fg">
      <div class="rounded-md border border-border-default bg-surface p-2 text-xs">
        <div class="flex flex-wrap items-center gap-3">
          <div class="font-semibold">Add Project modal harness (T6.5)</div>
          <button
            type="button"
            class="rounded border border-border-default bg-surface px-2 py-1 text-fg hover:bg-elevated"
            onClick={() => setOpen(true)}
          >
            Open modal
          </button>
          <label class="inline-flex items-center gap-1.5 text-fg-secondary">
            <input
              type="checkbox"
              checked={forceError()}
              onChange={(e) => setForceError(e.currentTarget.checked)}
            />
            Force backend error on submit
          </label>
          <span class="text-fg-tertiary">
            Browse rotates through {FAKE_PICKER_PATHS.length} fake paths.
          </span>
        </div>
      </div>
      <div class="overflow-auto rounded-md border border-border-default bg-surface p-3 text-xs">
        <div class="mb-2 font-semibold text-fg">Submissions ({submissions().length})</div>
        {submissions().length === 0 ? (
          <div class="text-fg-tertiary">No submissions yet.</div>
        ) : (
          <ul class="flex flex-col gap-1.5">
            <For each={submissions()}>
              {(s) => (
                <li class="font-mono text-fg-secondary">
                  {new Date(s.at).toISOString().slice(11, 19)} — {s.glyph} · {s.name} · {s.path} ·{" "}
                  <span style={{ color: s.color }}>{s.color}</span> · cli={s.defaultCli ?? "—"} ·
                  env={Object.keys(s.env).length}
                </li>
              )}
            </For>
          </ul>
        )}
      </div>
      <AddProjectModal
        open={open()}
        onClose={() => setOpen(false)}
        onPickFolder={onPickFolder}
        onSubmit={onSubmit}
      />
    </div>
  );
}

export default AddProjectModalLiveHarness;
