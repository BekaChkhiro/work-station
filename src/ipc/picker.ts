// T3.7: typed wrapper around the `pick_project_folder` Tauri command.
//
// Resolves to the canonicalized absolute path the user selected, or `null`
// if they cancelled the dialog. The Rust side rejects non-folders and
// symlink loops with a typed error matching the PTY/projects shape.

import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";

const PickResultSchema = z.string().nullable();

export async function pickProjectFolder(): Promise<string | null> {
  const raw = await invoke<unknown>("pick_project_folder");
  return PickResultSchema.parse(raw);
}
