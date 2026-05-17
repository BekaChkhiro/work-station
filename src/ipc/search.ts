// T13.9: typed wrapper for the `search_in_project` Tauri command —
// project-wide find-in-files via ripgrep.
//
// Mirrors the path-scoped pattern used by `read_text_file` (T13.3): the
// frontend hands the absolute project root to Rust, which canonicalizes
// it and pins ripgrep's CWD inside that boundary. Match paths come back
// relative to the root so the UI can render them compactly.

import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";

const MatchRangeSchema = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
});

const SearchMatchSchema = z.object({
  path: z.string(),
  lineNumber: z.number().int().positive(),
  column: z.number().int().positive(),
  text: z.string(),
  ranges: z.array(MatchRangeSchema),
});

const SearchResponseSchema = z.object({
  matches: z.array(SearchMatchSchema),
  truncated: z.boolean(),
});

export type SearchMatch = z.infer<typeof SearchMatchSchema>;
export type SearchResponse = z.infer<typeof SearchResponseSchema>;
export type MatchRange = z.infer<typeof MatchRangeSchema>;

export interface SearchOptions {
  /** Treat the query as a regex. Default `false` → literal substring. */
  regex?: boolean;
  /** Force case-sensitive matching (overrides smart-case). */
  caseSensitive?: boolean;
  /** Require the match to be bounded by word characters on both sides. */
  wholeWord?: boolean;
}

export async function searchInProject(
  projectRoot: string,
  query: string,
  options: SearchOptions = {},
): Promise<SearchResponse> {
  const raw = await invoke<unknown>("search_in_project", {
    projectRoot,
    query,
    options: {
      regex: options.regex === true,
      caseSensitive: options.caseSensitive === true,
      wholeWord: options.wholeWord === true,
    },
  });
  return SearchResponseSchema.parse(raw);
}
