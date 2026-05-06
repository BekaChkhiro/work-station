// T7.2: typed wrapper around the `cli_list_available` Tauri command.
//
// Returns the boot-detected CLI registry with best-effort `--version`
// metadata. Entries with a missing version surface `version: null`; the
// UI is expected to render those as blank labels (T7.2 acceptance).

import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";

const CliInfoSchema = z.object({
  name: z.string(),
  path: z.string(),
  version: z.string().nullable(),
});

const CliListSchema = z.array(CliInfoSchema);

export type CliInfo = z.infer<typeof CliInfoSchema>;

export async function cliListAvailable(): Promise<CliInfo[]> {
  const raw = await invoke<unknown>("cli_list_available");
  return CliListSchema.parse(raw);
}
