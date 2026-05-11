// T13.1: per-project scratch buffer for the Editor tab.
//
// The Editor tab currently mounts an empty Monaco instance with a starter
// placeholder so the user can verify the binding (acceptance: "Editor
// mounts in a tab, accepts text, no console errors on dispose"). Tab
// switches unmount the editor — we keep the typed content here so flipping
// to Terminal and back doesn't wipe the buffer.
//
// This is intentionally minimal. T13.3 replaces it with a file-backed
// buffer store that handles dirty state, save coordination, and the file
// tree's open-file flow.

import { createSignal } from "solid-js";

const DEFAULT_SCRATCH = [
  "// Editor scratch buffer — file open lands in T13.3.",
  "// Type freely; content survives tab switches within this session.",
  "",
].join("\n");

const [buffers, setBuffers] = createSignal<Record<string, string>>({});

export function editorScratch(projectId: string): string {
  const existing = buffers()[projectId];
  return existing ?? DEFAULT_SCRATCH;
}

export function setEditorScratch(projectId: string, value: string): void {
  setBuffers((prev) => ({ ...prev, [projectId]: value }));
}
