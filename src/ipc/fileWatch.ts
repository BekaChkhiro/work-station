// T13.5: typed wrappers around the file-watch IPC + Tauri event channel
// that the editor subscribes to.
//
// What the backend offers (see `src-tauri/src/commands/watch.rs`):
//   • `start_file_watch(projectRoot, relativePath)` → numeric watch ID
//   • `stop_file_watch(watchId)`
//   • Emits a `file:external-change` Tauri event whenever a watched
//     file's bytes change on disk — but never in response to our own
//     atomic save (the backend filters those via a hash check).
//
// On the frontend the watch ID is the only handle we need; the editor
// holds onto it for the lifetime of an open file and tears it down on
// close / file-switch / unmount.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { z } from "zod";

const ExternalChangeSchema = z.object({
  watchId: z.number().int().nonnegative(),
  content: z.string(),
  encoding: z.union([z.literal("utf-8"), z.literal("utf-8-bom")]),
  hash: z.string(),
});

export type ExternalChangeEvent = z.infer<typeof ExternalChangeSchema>;

export async function startFileWatch(projectRoot: string, relativePath: string): Promise<number> {
  const raw = await invoke<unknown>("start_file_watch", {
    projectRoot,
    relativePath,
  });
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw new Error(`start_file_watch returned non-numeric watch id: ${String(raw)}`);
  }
  return raw;
}

export async function stopFileWatch(watchId: number): Promise<void> {
  await invoke<unknown>("stop_file_watch", { watchId });
}

/**
 * Subscribe to external-change events for *all* watched files in this
 * window. Filtering by watch ID is the caller's job — we keep one
 * listener per editor instance instead of one per open file so a
 * cross-tab event broadcast (future feature) doesn't need a re-arm.
 *
 * Returns the `UnlistenFn` straight from Tauri; the caller must invoke
 * it on cleanup (Solid's `onCleanup`) or the listener leaks.
 */
export async function onExternalChange(
  handler: (event: ExternalChangeEvent) => void,
): Promise<UnlistenFn> {
  return listen<unknown>("file:external-change", (raw) => {
    const parsed = ExternalChangeSchema.safeParse(raw.payload);
    if (!parsed.success) {
      console.warn("[fileWatch] malformed external-change payload", parsed.error);
      return;
    }
    handler(parsed.data);
  });
}
