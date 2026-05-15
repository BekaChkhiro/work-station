// T13.2: typed wrapper around the `fs_list_dir` Tauri command — backing
// IPC for the editor file tree.
//
// The Rust side does canonicalization + noise filtering, so the frontend
// just hands over the path and trusts the response shape. Zod parses the
// payload so a future schema drift surfaces as a typed error at the call
// site instead of crashing inside the tree's `<For>`.
//
// T19.11: routes through `routeIpcLocalOnly`. The cloud-agent doesn't
// expose a filesystem RPC yet (no `fs_list_dir` in
// `src-tauri/src/ws/protocol.rs`), and silently dialing the local
// backend while the user is viewing a remote workspace would list the
// desktop's filesystem under remote project paths — a data-source
// confusion the routing layer is designed to prevent. Cloud mode
// surfaces `CloudTransportUnsupportedError` so the editor file tree can
// render a "not available on remote workspace yet" affordance.

import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";

import { routeIpcLocalOnly } from "./transport";

const FsDirEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  isDir: z.boolean(),
});

const FsListResultSchema = z.array(FsDirEntrySchema);

export type FsDirEntry = z.infer<typeof FsDirEntrySchema>;

export interface FsListDirOptions {
  /** When true (default), skip noisy build/tool dirs like `.git` and
   *  `node_modules`. Set false for raw listing. */
  respectGitignore?: boolean;
}

export async function fsListDir(
  path: string,
  options: FsListDirOptions = {},
): Promise<FsDirEntry[]> {
  return routeIpcLocalOnly("fs_list_dir", async () => {
    const raw = await invoke<unknown>("fs_list_dir", {
      path,
      respectGitignore: options.respectGitignore ?? true,
    });
    return FsListResultSchema.parse(raw);
  });
}
