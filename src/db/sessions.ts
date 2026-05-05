// Sessions DB helpers — Zod schema for the `sessions.layout_json` column.
//
// T3.3: layout_json is a TEXT column in SQLite (see migrations/0002_sessions.sql)
// holding a JSON-encoded tree of splits + pane → session_id mappings.
// `parseLayout` validates with Zod on read and falls back to an empty layout
// when the stored JSON is missing, malformed, or fails the schema, per
// PROJECT_PLAN T3.3 acceptance.
//
// The full split-tree shape (recursive `split` nodes) lands in T5.1; here we
// only need the leaf (`pane`) and the empty case so corrupt rows surface as
// "no layout" rather than a runtime crash.

import { z } from "zod";

export const PaneNodeSchema = z.object({
  type: z.literal("pane"),
  sessionId: z.string().min(1),
});

export const EmptyLayoutSchema = z.object({}).strict();

// Until T5.1 fleshes out the recursive `split` shape, accept either the empty
// placeholder ({}) or a single leaf pane. Anything else falls back to empty.
export const LayoutSchema = z.union([EmptyLayoutSchema, PaneNodeSchema]);

export type Layout = z.infer<typeof LayoutSchema>;

export const EMPTY_LAYOUT: Layout = {};

/** Parse a `sessions.layout_json` value. Returns `EMPTY_LAYOUT` on any failure. */
export function parseLayout(raw: string | null | undefined): Layout {
  if (!raw) return EMPTY_LAYOUT;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return EMPTY_LAYOUT;
  }
  const result = LayoutSchema.safeParse(json);
  return result.success ? result.data : EMPTY_LAYOUT;
}
